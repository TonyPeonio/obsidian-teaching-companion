/**
 * One grading pass: the rubric's criteria are batched to fit the context window (all in one
 * call when the submission leaves room), each batch is one model call with a strict JSON
 * reply, and every field that comes back is validated. Scores outside the allowed range are
 * clamped and flagged; quotes that are not in the submission are dropped and counted;
 * criteria the model skipped are reported, never invented.
 */

import type { ChatMessage } from "./ollama";
import { normalizeName as normalizeKey, type Criterion, type Rubric } from "./rubric";
import { estimateTokens, locateQuote, truncateToTokens, type Submission } from "./text";

export interface Quote {
	text: string;
	/** "p. 3", "¶ 7", or the model's own description when ours is unavailable. */
	location: string;
}

export interface CriterionResult {
	criterion: string;
	/** null when the model did not return this criterion. */
	proposed: number | null;
	max: number;
	justification: string;
	quotes: Quote[];
	/** Human-readable validation notes ("score 7 clamped to 5", "2 quotes dropped"). */
	flags: string[];
}

export interface GradingResult {
	results: CriterionResult[];
	totalProposed: number;
	totalMax: number;
	droppedQuotes: number;
	missingCriteria: string[];
	/** True when the submission text was cut to fit the context window. */
	truncated: boolean;
	calls: number;
}

export interface BatchPlan {
	batches: Criterion[][];
	/** The submission text actually sent (possibly truncated). */
	text: string;
	truncated: boolean;
}

/** Tokens reserved for the reply per criterion: score, a sentence and up to three quotes. */
export const REPLY_TOKENS_PER_CRITERION = 320;
/** Fixed prompt overhead: system prompt, instructions, JSON scaffolding. */
const PROMPT_OVERHEAD_TOKENS = 700;

export function criterionTokens(c: Criterion): number {
	return estimateTokens(criterionText(c)) + REPLY_TOKENS_PER_CRITERION;
}

/**
 * Splits the criteria into the fewest batches whose prompt fits `numCtx`. When even one
 * criterion plus the submission does not fit, the submission is truncated so that it does.
 */
export function planBatches(rubric: Rubric, submission: Submission, numCtx: number): BatchPlan {
	const budget = Math.max(1024, numCtx - PROMPT_OVERHEAD_TOKENS);
	const largest = rubric.criteria.reduce((m, c) => Math.max(m, criterionTokens(c)), 0);
	let text = submission.text;
	let truncated = false;
	const roomForText = budget - largest;
	if (estimateTokens(text) > roomForText) {
		text = truncateToTokens(text, Math.max(200, roomForText));
		truncated = true;
	}
	const remaining = budget - estimateTokens(text);
	const batches: Criterion[][] = [];
	let current: Criterion[] = [];
	let used = 0;
	for (const c of rubric.criteria) {
		const cost = criterionTokens(c);
		if (current.length > 0 && used + cost > remaining) {
			batches.push(current);
			current = [];
			used = 0;
		}
		current.push(c);
		used += cost;
	}
	if (current.length) batches.push(current);
	return { batches, text, truncated };
}

// ---------------------------------------------------------------- prompts

export function gradingSystemPrompt(): string {
	return [
		"You are a careful teaching assistant grading one student submission against a rubric.",
		"Judge only what the submission says. Do not reward or penalise anything the rubric does not ask for.",
		"For each criterion give a score within its allowed range, one sentence of justification, and 1 to 3 short quotes copied verbatim from the submission as evidence, each with where it appears.",
		"Quotes must be exact substrings of the submission text (same words, same order). Never paraphrase a quote. If nothing in the submission supports a criterion, give an empty evidence list and say so in the justification.",
		"Reply with JSON only, no prose and no code fences, in exactly this shape:",
		'{"criteria":[{"criterion":"<name exactly as given>","score":<number>,"justification":"<one sentence>","evidence":[{"quote":"<verbatim>","location":"<page or paragraph, e.g. p. 2 or paragraph 3>"}]}]}',
	].join("\n");
}

export function gradingUserMessage(rubric: Rubric, criteria: Criterion[], text: string, submissionName: string): string {
	const parts: string[] = [];
	parts.push(`Rubric: ${rubric.name}`);
	parts.push("");
	parts.push("Criteria to score in this reply (score each one, no others):");
	for (const c of criteria) parts.push(criterionText(c));
	parts.push("");
	parts.push(`Submission "${submissionName}":`);
	parts.push("<<<SUBMISSION");
	parts.push(text);
	parts.push("SUBMISSION>>>");
	parts.push("");
	parts.push(`Return JSON with exactly ${criteria.length} entries in "criteria", in the order given, using these names: ${criteria.map((c) => JSON.stringify(c.name)).join(", ")}.`);
	return parts.join("\n");
}

export function gradingMessages(rubric: Rubric, criteria: Criterion[], text: string, submissionName: string): ChatMessage[] {
	return [
		{ role: "system", content: gradingSystemPrompt() },
		{ role: "user", content: gradingUserMessage(rubric, criteria, text, submissionName) },
	];
}

export function criterionText(c: Criterion): string {
	const lines = [`- ${c.name} (0 to ${c.maxPoints} points): ${c.description || "(no description)"}`];
	for (const l of c.levels) lines.push(`    ${l.points}: ${l.description}`);
	return lines.join("\n");
}

// ---------------------------------------------------------------- reply validation

export class GradingParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GradingParseError";
	}
}

/** The JSON object in a reply that may carry fences or stray prose around it. */
export function extractJson(reply: string): unknown {
	let s = reply.trim();
	s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
	const first = s.indexOf("{");
	const last = s.lastIndexOf("}");
	if (first < 0 || last < first) throw new GradingParseError("The model's reply contained no JSON object.");
	const candidate = s.slice(first, last + 1);
	try {
		return JSON.parse(candidate);
	} catch {
		// Common small-model slips: trailing commas.
		try {
			return JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1"));
		} catch {
			throw new GradingParseError("The model's reply was not valid JSON.");
		}
	}
}

interface ReplyEntry {
	criterion: string;
	score: unknown;
	justification: unknown;
	evidence: unknown;
}

function readEntries(json: unknown): ReplyEntry[] {
	const obj = json as Record<string, unknown> | unknown[] | null;
	let list: unknown[] | undefined;
	if (Array.isArray(obj)) list = obj;
	else if (obj && typeof obj === "object") {
		const o = obj;
		const arr = o.criteria ?? o.results ?? o.scores ?? o.grades;
		if (Array.isArray(arr)) list = arr;
		else {
			// {"Thesis": {...}, "Evidence": {...}}
			const entries = Object.entries(o).filter(([, v]) => v && typeof v === "object" && !Array.isArray(v));
			if (entries.length) list = entries.map(([k, v]) => ({ criterion: k, ...(v as Record<string, unknown>) }));
		}
	}
	if (!list) throw new GradingParseError('The model\'s JSON had no "criteria" array.');
	return list
		.filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
		.map((e) => ({
			criterion: asString(e.criterion ?? e.name ?? e.criteria ?? e.title),
			score: e.score ?? e.proposed ?? e.points ?? e.proposed_score,
			justification: e.justification ?? e.reason ?? e.rationale ?? e.explanation,
			evidence: e.evidence ?? e.quotes,
		}));
}

function toNumber(v: unknown): number | null {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string") {
		const m = /-?\d+(?:\.\d+)?/.exec(v);
		if (m) return Number(m[0]);
	}
	return null;
}

function readQuotes(v: unknown): { text: string; location: string }[] {
	if (!Array.isArray(v)) return [];
	const out: { text: string; location: string }[] = [];
	for (const item of v) {
		if (typeof item === "string") out.push({ text: item, location: "" });
		else if (item && typeof item === "object") {
			const o = item as Record<string, unknown>;
			const text = o.quote ?? o.text ?? o.excerpt;
			if (typeof text !== "string") continue;
			out.push({ text, location: asString(o.location ?? o.page ?? o.paragraph ?? o.where) });
		}
	}
	return out;
}

/** Strings and numbers as text; anything else (objects, null) as "". */
function asString(v: unknown): string {
	if (typeof v === "string") return v;
	if (typeof v === "number" && Number.isFinite(v)) return String(v);
	return "";
}

/**
 * Validates one batch's reply against the criteria it was asked about. Criteria the model
 * left out come back with `proposed: null`; extra criteria are ignored.
 */
export function parseGradingReply(reply: string, criteria: Criterion[], submission: Submission): { results: CriterionResult[]; droppedQuotes: number } {
	const entries = readEntries(extractJson(reply));
	const byKey = new Map<string, ReplyEntry>();
	for (const e of entries) {
		const key = normalizeKey(e.criterion);
		if (key && !byKey.has(key)) byKey.set(key, e);
	}
	let droppedQuotes = 0;
	const results: CriterionResult[] = criteria.map((c) => {
		const entry = byKey.get(normalizeKey(c.name)) ?? looseMatch(byKey, c.name);
		if (!entry) return { criterion: c.name, proposed: null, max: c.maxPoints, justification: "", quotes: [], flags: ["Not scored by the model."] };
		const flags: string[] = [];
		let score = toNumber(entry.score);
		if (score === null) {
			flags.push("No numeric score in the reply; set to 0.");
			score = 0;
		} else if (score < 0 || score > c.maxPoints) {
			const clamped = Math.min(Math.max(score, 0), c.maxPoints);
			flags.push(`Score ${score} was outside 0–${c.maxPoints}; clamped to ${clamped}.`);
			score = clamped;
		}
		score = Math.round(score * 100) / 100;
		const justification = typeof entry.justification === "string" ? entry.justification.trim() : "";
		if (!justification) flags.push("No justification in the reply.");
		const quotes: Quote[] = [];
		let dropped = 0;
		for (const q of readQuotes(entry.evidence)) {
			const text = q.text.trim();
			if (!text) continue;
			const where = locateQuote(submission, text);
			if (!where.found) {
				dropped++;
				continue;
			}
			if (quotes.length < 3) quotes.push({ text, location: where.location && where.location !== "text" && where.location !== "pages" ? where.location : q.location || where.location || "" });
		}
		if (dropped) flags.push(`${dropped} quote${dropped === 1 ? "" : "s"} not found in the submission; dropped.`);
		droppedQuotes += dropped;
		return { criterion: c.name, proposed: score, max: c.maxPoints, justification, quotes, flags };
	});
	return { results, droppedQuotes };
}

function looseMatch(byKey: Map<string, ReplyEntry>, name: string): ReplyEntry | undefined {
	const key = normalizeKey(name);
	for (const [k, e] of byKey) {
		if (k.includes(key) || key.includes(k)) return e;
	}
	return undefined;
}

// ---------------------------------------------------------------- orchestration

/** The one thing the grader needs from a model: a chat that returns the reply text. */
export type ChatFn = (messages: ChatMessage[], signal?: AbortSignal) => Promise<string>;

export interface GradeOptions {
	numCtx: number;
	signal?: AbortSignal;
	onProgress?(done: number, total: number): void;
}

export async function gradeSubmission(rubric: Rubric, submission: Submission, chat: ChatFn, opts: GradeOptions): Promise<GradingResult> {
	if (rubric.criteria.length === 0) throw new GradingParseError("The rubric has no criteria.");
	const plan = planBatches(rubric, submission, opts.numCtx);
	const results: CriterionResult[] = [];
	let droppedQuotes = 0;
	for (const [i, batch] of plan.batches.entries()) {
		opts.onProgress?.(i, plan.batches.length);
		const reply = await chat(gradingMessages(rubric, batch, plan.text, submission.name), opts.signal);
		const parsed = parseGradingReply(reply, batch, submission);
		results.push(...parsed.results);
		droppedQuotes += parsed.droppedQuotes;
	}
	opts.onProgress?.(plan.batches.length, plan.batches.length);
	return summarize(results, droppedQuotes, plan.truncated, plan.batches.length);
}

export function summarize(results: CriterionResult[], droppedQuotes: number, truncated: boolean, calls: number): GradingResult {
	const totalProposed = Math.round(results.reduce((s, r) => s + (r.proposed ?? 0), 0) * 100) / 100;
	const totalMax = results.reduce((s, r) => s + r.max, 0);
	return { results, totalProposed, totalMax, droppedQuotes, missingCriteria: results.filter((r) => r.proposed === null).map((r) => r.criterion), truncated, calls };
}
