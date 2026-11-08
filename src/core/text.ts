/**
 * Text helpers shared by grading and the grade book: token estimates for the context
 * budget, whitespace/case normalisation for quote grounding, and locating a quote in a
 * submission by page or paragraph.
 */

/** Rough characters-per-token for English prose; the same constant the suite uses elsewhere. */
export const CHARS_PER_TOKEN = 3.2;

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Keeps at most `tokens` worth of text, cutting at a line break when one is near the limit. */
export function truncateToTokens(text: string, tokens: number): string {
	const maxChars = Math.max(0, Math.floor(tokens * CHARS_PER_TOKEN));
	if (text.length <= maxChars) return text;
	const cut = text.slice(0, maxChars);
	const nl = cut.lastIndexOf("\n");
	return (nl > maxChars * 0.8 ? cut.slice(0, nl) : cut).trimEnd();
}

/**
 * Lower-cases, straightens typographic quotes and dashes, and collapses whitespace so a
 * quote the model re-typed can still be found in the submission.
 */
export function normalizeForMatch(s: string): string {
	return s
		.toLowerCase()
		.replace(/[‘’‚‛]/g, "'")
		.replace(/[“”„‟]/g, '"')
		.replace(/[–—−]/g, "-")
		.replace(/…/g, "...")
		.replace(/\s+/g, " ")
		.trim();
}

/** Blank-line separated paragraphs, each with its whitespace collapsed; empty ones dropped. */
export function splitParagraphs(text: string): string[] {
	return text
		.split(/\n\s*\n/)
		.map((p) => p.replace(/\s+/g, " ").trim())
		.filter((p) => p.length > 0);
}

export interface Submission {
	/** Display name, usually the file's basename. */
	name: string;
	/** Full extracted text. For PDFs the pages are joined with blank lines. */
	text: string;
	/** Page texts when the submission came from a PDF (page 1 at index 0). */
	pages?: string[];
	/** Where the text came from, for the grading note. */
	source: string;
}

export interface QuoteLocation {
	found: boolean;
	/** "p. 3" for PDFs, "¶ 7" for plain text; undefined when not found. */
	location?: string;
}

/** Whether `quote` appears verbatim (after normalisation) and roughly where. */
export function locateQuote(submission: Submission, quote: string): QuoteLocation {
	const needle = normalizeForMatch(quote);
	if (needle.length < 3) return { found: false };
	if (submission.pages && submission.pages.length > 0) {
		for (let i = 0; i < submission.pages.length; i++) {
			if (normalizeForMatch(submission.pages[i]).includes(needle)) return { found: true, location: `p. ${i + 1}` };
		}
		// A quote may span a page break; accept it without a page.
		if (normalizeForMatch(submission.text).includes(needle)) return { found: true, location: "pages" };
		return { found: false };
	}
	const paragraphs = splitParagraphs(submission.text);
	for (let i = 0; i < paragraphs.length; i++) {
		if (normalizeForMatch(paragraphs[i]).includes(needle)) return { found: true, location: `¶ ${i + 1}` };
	}
	if (normalizeForMatch(submission.text).includes(needle)) return { found: true, location: "text" };
	return { found: false };
}

/** Builds a submission from plain text; `pages` for a PDF keeps page numbers available. */
export function makeSubmission(name: string, text: string, source: string, pages?: string[]): Submission {
	const body = pages ? pages.join("\n\n") : text;
	return { name, text: body.replace(/\r\n/g, "\n").trim(), pages, source };
}

export function escapeCell(s: string): string {
	return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

export function formatNumber(n: number): string {
	return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}
