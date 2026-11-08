/**
 * Turns a vault file into a `Submission`: notes and .txt files are read as text (a note's
 * frontmatter is dropped), PDFs go through the injected pdf.js loader page by page so the
 * evidence can cite pages.
 */

import { parseFrontmatter } from "./frontmatter";
import type { PdfPages } from "./pdf";
import { makeSubmission, type Submission } from "./text";
import { SUBMISSION_EXTENSIONS, type FileInfo, type VaultAccess } from "./vault";

export type PdfExtractor = (bytes: Uint8Array) => Promise<PdfPages>;

export class SubmissionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SubmissionError";
	}
}

export function isSubmissionFile(f: FileInfo): boolean {
	return SUBMISSION_EXTENSIONS.includes(f.extension);
}

export async function loadSubmission(vault: VaultAccess, file: FileInfo, extractPdf?: PdfExtractor): Promise<Submission> {
	if (file.extension === "pdf") {
		if (!extractPdf) throw new SubmissionError("PDF reading is not available here.");
		const bytes = await vault.readBinary(file.path);
		const { pages, numPages } = await extractPdf(bytes);
		if (pages.every((p) => p.trim().length === 0)) throw new SubmissionError(`"${file.basename}.pdf" has no extractable text (a scan without OCR).`);
		const sub = makeSubmission(file.basename, "", file.path, pages);
		if (numPages > pages.length) sub.source += ` (first ${pages.length} of ${numPages} pages)`;
		return sub;
	}
	if (file.extension === "md" || file.extension === "txt") {
		const raw = await vault.read(file.path);
		const text = file.extension === "md" ? parseFrontmatter(raw).body : raw;
		if (!text.trim()) throw new SubmissionError(`"${file.basename}.${file.extension}" is empty.`);
		return makeSubmission(file.basename, text, file.path);
	}
	throw new SubmissionError(`Cannot read .${file.extension} files; submissions must be .md, .txt or .pdf.`);
}

export function pastedSubmission(name: string, text: string): Submission {
	if (!text.trim()) throw new SubmissionError("The pasted text is empty.");
	return makeSubmission(name.trim() || "Pasted submission", text, "pasted text");
}
