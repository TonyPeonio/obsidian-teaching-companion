/**
 * Draft comments to the student, derived deterministically from the model's justification:
 * addressed to the student, with any score talk removed (the comment is feedback, the score
 * is the grader's decision), and in the detailed tone a quote and the next rubric level.
 */

import type { CriterionResult } from "./grading";
import type { Criterion } from "./rubric";

export type CommentTone = "brief" | "detailed";

export interface CommentOptions {
	tone: CommentTone;
	includeQuotes: boolean;
}

/** Removes "4/5", "4 out of 5", "scored 3", "3 points", "full marks" and similar from a sentence. */
export function stripScores(s: string): string {
	let t = s;
	// "scores 3/5", "earns 8 out of 10 points", "deserves a score of 4"
	t = t.replace(/\b(?:scores?|scored|scoring|earns?|earned|deserves?|receives?|gets?|awarded|merits?|warrants?|worth)\s+(?:a\s+|an\s+|the\s+)?(?:score\s+of\s+|full\s+|partial\s+|maximum\s+)?\(?\d+(?:\.\d+)?(?:\s*(?:\/|out of)\s*\d+(?:\.\d+)?)?\s*(?:points?|pts|marks)?\)?/gi, "");
	t = t.replace(/\(?\b\d+(?:\.\d+)?\s*(?:\/|out of)\s*\d+(?:\.\d+)?\s*(?:points?|pts|marks)?\)?/gi, "");
	t = t.replace(/\b(?:a\s+)?(?:score|grade|mark)\s+of\s+\d+(?:\.\d+)?\b/gi, "");
	t = t.replace(/\b\d+(?:\.\d+)?\s*(?:points?|pts|marks)\b/gi, "");
	t = t.replace(/\b(?:full|maximum|partial|zero|no)\s+(?:marks|points|credit)\b/gi, "");
	t = t
		.replace(/\(\s*\)/g, "")
		.replace(/\s{2,}/g, " ")
		.replace(/\s+([,.;:])/g, "$1")
		.replace(/[,;:]+\s*([.!?])/g, "$1")
		.replace(/,\s*,/g, ",")
		.replace(/^[\s,.;:]+/, "")
		.trim();
	if (t && !/[.!?]$/.test(t)) t += ".";
	return t ? t[0].toUpperCase() + t.slice(1) : "";
}

/** "The student argues…" → "You argue…" is too risky to conjugate; only possessives and subjects that read well are rewritten. */
export function addressStudent(s: string): string {
	return s
		.replace(/\bthe student's\b/gi, "your")
		.replace(/\bthe author's\b/gi, "your")
		.replace(/\bthe writer's\b/gi, "your")
		.replace(/\bthe submission's\b/gi, "your work's")
		.replace(/\bthe submission\b/gi, "your work")
		.replace(/\bthe student\b/gi, "you")
		.replace(/\bthe author\b/gi, "you")
		.replace(/\bthe writer\b/gi, "you");
}

export function draftComment(result: CriterionResult, criterion: Criterion | undefined, opts: CommentOptions): string {
	if (result.proposed === null) return "No comment drafted: the model did not score this criterion.";
	const core = stripScores(addressStudent(result.justification)) || `This part of the rubric looks at: ${(criterion?.description ?? result.criterion).replace(/[.!?]+$/, "")}.`;
	const parts: string[] = [];
	const full = result.proposed >= result.max && result.max > 0;
	if (full) parts.push("Nicely done.");
	parts.push(core);
	if (opts.tone === "detailed") {
		if (opts.includeQuotes && result.quotes.length) parts.push(`For example, you wrote: "${result.quotes[0].text}".`);
		const next = nextLevel(result, criterion);
		if (next) parts.push(`To strengthen this: ${lowerFirst(next)}`);
	} else if (opts.includeQuotes && result.quotes.length) {
		parts.push(`(See: "${shorten(result.quotes[0].text, 120)}".)`);
	}
	return parts.join(" ");
}

/** The description of the first rubric level above the proposed score, without its label. */
export function nextLevel(result: CriterionResult, criterion: Criterion | undefined): string | undefined {
	if (!criterion || result.proposed === null || result.proposed >= result.max) return undefined;
	const above = [...criterion.levels].sort((a, b) => a.points - b.points).find((l) => l.points > (result.proposed ?? 0));
	if (!above) return undefined;
	const text = above.description.replace(/^[A-Za-z][A-Za-z ]{0,20}:\s*/, "").trim();
	if (!text) return undefined;
	const sentence = /[.!?]$/.test(text) ? text : text + ".";
	return sentence[0].toUpperCase() + sentence.slice(1);
}

function lowerFirst(s: string): string {
	return s ? s[0].toLowerCase() + s.slice(1) : s;
}

function shorten(s: string, n: number): string {
	return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}
