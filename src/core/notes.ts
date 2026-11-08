/**
 * The grading note: one per submission under `<grading folder>/<rubric>/<submission>.md`.
 * Frontmatter for the grade book, a scores table with an empty "Your score" column the
 * grader fills in, the evidence quotes, draft comments, and the validation notes. The
 * parser reads the table back (including "Your score") so the grade book and re-grading
 * can use what the grader typed.
 */

import { draftComment, type CommentOptions } from "./comments";
import { parseFrontmatter, renderFrontmatter } from "./frontmatter";
import type { GradingResult } from "./grading";
import { findCriterion, type Rubric } from "./rubric";
import { escapeCell, formatNumber, type Submission } from "./text";
import { joinPath, safeFileName } from "./vault";

export const BANNER = "Draft by a local model. Scores are proposals until you fill in 'your score'.";

export interface GradingNoteInput {
	rubric: Rubric;
	submission: Submission;
	result: GradingResult;
	model: string;
	/** YYYY-MM-DD */
	date: string;
	comments: CommentOptions;
	/** "Your score" values from a previous grading note, carried over by criterion name. */
	previousScores?: Map<string, number>;
}

export function gradingNotePath(gradingFolder: string, rubricName: string, submissionName: string): string {
	return joinPath(gradingFolder, safeFileName(rubricName), `${safeFileName(submissionName)}.md`);
}

export function gradingFolderFor(gradingFolder: string, rubricName: string): string {
	return joinPath(gradingFolder, safeFileName(rubricName));
}

export function renderGradingNote(input: GradingNoteInput): string {
	const { rubric, submission, result } = input;
	const out: string[] = [];
	out.push(
		renderFrontmatter({
			rubric: rubric.name,
			submission: submission.name,
			source: submission.source,
			total_proposed: formatNumber(result.totalProposed),
			total_max: formatNumber(result.totalMax),
			status: "draft",
			graded: input.date,
			model: input.model,
		}),
	);
	out.push("");
	out.push(`> [!warning] ${BANNER}`);
	out.push("");
	out.push("## Scores");
	out.push("");
	out.push("| Criterion | Proposed | Max | Your score | Justification |");
	out.push("|---|---|---|---|---|");
	for (const r of result.results) {
		const prev = input.previousScores?.get(r.criterion);
		out.push(`| ${escapeCell(r.criterion)} | ${r.proposed === null ? "" : formatNumber(r.proposed)} | ${formatNumber(r.max)} | ${prev === undefined ? "" : formatNumber(prev)} | ${escapeCell(r.justification)} |`);
	}
	out.push(`| **Total** | ${formatNumber(result.totalProposed)} | ${formatNumber(result.totalMax)} | | |`);
	out.push("");
	out.push("## Evidence");
	out.push("");
	for (const r of result.results) {
		out.push(`### ${r.criterion}`);
		out.push("");
		if (r.quotes.length === 0) out.push(r.proposed === null ? "_Not scored by the model._" : "_No verbatim evidence was found for this criterion._");
		for (const q of r.quotes) out.push(`> "${q.text.replace(/\r?\n/g, " ")}"${q.location ? ` — ${q.location}` : ""}`);
		out.push("");
	}
	out.push("## Comments");
	out.push("");
	out.push("_Drafts to the student, written from the justifications. Edit freely; they never mention scores._");
	out.push("");
	for (const r of result.results) {
		out.push(`### ${r.criterion}`);
		out.push("");
		out.push(draftComment(r, findCriterion(rubric.criteria, r.criterion), input.comments));
		out.push("");
	}
	out.push("## Grading notes");
	out.push("");
	out.push(`- Graded by ${input.model} on ${input.date} in ${result.calls} model call${result.calls === 1 ? "" : "s"}; nothing left this machine.`);
	if (result.droppedQuotes) out.push(`- ${result.droppedQuotes} quote${result.droppedQuotes === 1 ? "" : "s"} the model offered ${result.droppedQuotes === 1 ? "was" : "were"} not found verbatim in the submission and ${result.droppedQuotes === 1 ? "was" : "were"} dropped.`);
	if (result.truncated) out.push("- The submission was longer than the context window; the end was cut before grading. Raise the context size in settings and re-grade for a full read.");
	if (result.missingCriteria.length) out.push(`- Not scored by the model: ${result.missingCriteria.join(", ")}. Score these by hand.`);
	for (const r of result.results) {
		for (const f of r.flags) {
			if (/not found in the submission|Not scored by the model/.test(f)) continue;
			out.push(`- ${r.criterion}: ${f}`);
		}
	}
	if (input.previousScores?.size) out.push("- \"Your score\" values were carried over from the previous grading note.");
	out.push("");
	return out.join("\n");
}

// ---------------------------------------------------------------- reading back

export interface ScoreRow {
	criterion: string;
	proposed: number | null;
	max: number;
	yourScore: number | null;
	justification: string;
}

export interface GradingNoteSummary {
	rubric: string;
	submission: string;
	status: string;
	totalProposed: number;
	totalMax: number;
	rows: ScoreRow[];
	/** Sum of "Your score" when every row has one; null otherwise. */
	finalTotal: number | null;
	/** True when every criterion has a "Your score". */
	complete: boolean;
}

/** Reads a grading note; null when the note is not one (no Scores table). */
export function parseGradingNote(content: string): GradingNoteSummary | null {
	const { data, body } = parseFrontmatter(content);
	const rows = parseScoresTable(body);
	if (!rows) return null;
	const totalMax = rows.reduce((s, r) => s + r.max, 0);
	const totalProposed = Math.round(rows.reduce((s, r) => s + (r.proposed ?? 0), 0) * 100) / 100;
	const complete = rows.length > 0 && rows.every((r) => r.yourScore !== null);
	const finalTotal = complete ? Math.round(rows.reduce((s, r) => s + (r.yourScore ?? 0), 0) * 100) / 100 : null;
	return {
		rubric: typeof data.rubric === "string" ? data.rubric : "",
		submission: typeof data.submission === "string" ? data.submission : "",
		status: typeof data.status === "string" ? data.status : "draft",
		totalProposed,
		totalMax,
		rows,
		finalTotal,
		complete,
	};
}

function parseScoresTable(body: string): ScoreRow[] | null {
	const lines = body.split(/\r?\n/);
	const start = lines.findIndex((l) => /^\|\s*criterion\s*\|\s*proposed\s*\|\s*max\s*\|\s*your score\s*\|/i.test(l));
	if (start < 0) return null;
	const rows: ScoreRow[] = [];
	for (let i = start + 2; i < lines.length && lines[i].trim().startsWith("|"); i++) {
		const cells = splitCells(lines[i]);
		if (cells.length < 4) continue;
		const name = cells[0].replace(/\*+/g, "").trim();
		if (!name || /^total$/i.test(name)) continue;
		rows.push({
			criterion: name,
			proposed: parseScoreCell(cells[1]),
			max: parseScoreCell(cells[2]) ?? 0,
			yourScore: parseScoreCell(cells[3]),
			justification: cells[4] ?? "",
		});
	}
	return rows;
}

/** "4", "4.5", "4/5", "4 pts" → 4; empty or non-numeric → null. */
export function parseScoreCell(s: string): number | null {
	const m = /-?\d+(?:\.\d+)?/.exec(s.replace(/\*+/g, ""));
	return m ? Number(m[0]) : null;
}

function splitCells(line: string): string[] {
	let s = line.trim();
	if (s.startsWith("|")) s = s.slice(1);
	if (s.endsWith("|")) s = s.slice(0, -1);
	const cells: string[] = [];
	let cur = "";
	for (let i = 0; i < s.length; i++) {
		if (s[i] === "\\" && s[i + 1] === "|") {
			cur += "|";
			i++;
		} else if (s[i] === "|") {
			cells.push(cur.trim());
			cur = "";
		} else cur += s[i];
	}
	cells.push(cur.trim());
	return cells;
}

/** The grader's "Your score" entries by criterion, for carrying over on a re-grade. */
export function yourScoresOf(summary: GradingNoteSummary | null): Map<string, number> {
	const map = new Map<string, number>();
	for (const r of summary?.rows ?? []) if (r.yourScore !== null) map.set(r.criterion, r.yourScore);
	return map;
}

// ---------------------------------------------------------------- sections

/** Replaces the body of `## heading` (to the next `##` or higher), or appends the section. */
export function replaceSection(content: string, heading: string, body: string): string {
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`^##\\s+${escaped}\\s*$`, "m");
	const m = re.exec(content);
	const section = `## ${heading}\n\n${body.trim()}\n`;
	if (!m) {
		const sep = content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
		return content + sep + section;
	}
	const after = content.slice(m.index + m[0].length);
	const next = /^#{1,2}\s+\S/m.exec(after);
	const tail = next ? after.slice(next.index) : "";
	return content.slice(0, m.index) + section + (tail ? "\n" + tail : "");
}
