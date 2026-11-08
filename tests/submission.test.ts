import { describe, expect, it } from "vitest";
import { extractPdfPages, type PdfJsLike } from "../src/core/pdf";
import { isSubmissionFile, loadSubmission, pastedSubmission } from "../src/core/submission";
import { locateQuote } from "../src/core/text";
import { filesInFolder, joinPath, notesUnder, safeFileName, writeNote } from "../src/core/vault";
import { FakeVault } from "./fakes";

const vault = new FakeVault({
	"Submissions/alice.md": "---\nstudent: alice\n---\n# Essay\n\nFirst paragraph here.\n\nSecond paragraph here.\n",
	"Submissions/bob.txt": "Plain text submission.\r\n\r\nWith two paragraphs.",
	"Submissions/carol.pdf": new Uint8Array([1, 2, 3]),
	"Submissions/empty.md": "---\nx: 1\n---\n",
	"Submissions/notes.docx": "nope",
	"Submissions/sub/deeper.md": "nested",
	"Teaching/Rubrics/Essay rubric.md": "| Criterion | Points | Description |\n|---|---|---|\n| A | 1 | a |\n",
});

const fakePdf = async () => ({ pages: ["Page one text.", "Page two says something else."], numPages: 2 });

describe("loadSubmission", () => {
	it("reads a note without its frontmatter and locates quotes by paragraph", async () => {
		const file = vault.listFiles().find((f) => f.path === "Submissions/alice.md");
		const sub = await loadSubmission(vault, file!, fakePdf);
		expect(sub.name).toBe("alice");
		expect(sub.text.startsWith("# Essay")).toBe(true);
		expect(sub.text).not.toContain("student: alice");
		expect(locateQuote(sub, "second paragraph")).toEqual({ found: true, location: "¶ 3" });
		expect(locateQuote(sub, "not there")).toEqual({ found: false });
	});

	it("reads .txt files and normalises line endings", async () => {
		const file = vault.listFiles().find((f) => f.path === "Submissions/bob.txt");
		const sub = await loadSubmission(vault, file!);
		expect(sub.text).toBe("Plain text submission.\n\nWith two paragraphs.");
		expect(sub.source).toBe("Submissions/bob.txt");
	});

	it("reads PDFs page by page through the injected extractor and locates quotes by page", async () => {
		const file = vault.listFiles().find((f) => f.path === "Submissions/carol.pdf");
		const sub = await loadSubmission(vault, file!, fakePdf);
		expect(sub.pages).toHaveLength(2);
		expect(sub.text).toBe("Page one text.\n\nPage two says something else.");
		expect(locateQuote(sub, "SOMETHING else")).toEqual({ found: true, location: "p. 2" });
	});

	it("rejects empty files, unknown extensions, PDFs without text and PDFs without an extractor", async () => {
		const by = (p: string) => vault.listFiles().find((f) => f.path === p)!;
		await expect(loadSubmission(vault, by("Submissions/empty.md"))).rejects.toThrow(/is empty/);
		await expect(loadSubmission(vault, by("Submissions/notes.docx"))).rejects.toThrow(/\.md, \.txt or \.pdf/);
		await expect(loadSubmission(vault, by("Submissions/carol.pdf"))).rejects.toThrow(/not available/);
		await expect(loadSubmission(vault, by("Submissions/carol.pdf"), async () => ({ pages: ["", " "], numPages: 2 }))).rejects.toThrow(/no extractable text/);
	});

	it("builds a pasted submission and rejects empty text", () => {
		const sub = pastedSubmission("  dana ", "Some pasted text.");
		expect(sub.name).toBe("dana");
		expect(sub.source).toBe("pasted text");
		expect(() => pastedSubmission("x", "  ")).toThrow(/empty/);
	});
});

describe("vault helpers", () => {
	it("lists submission files directly in a folder and notes under a folder", () => {
		const direct = filesInFolder(vault, "Submissions").filter(isSubmissionFile);
		expect(direct.map((f) => f.path)).toEqual(["Submissions/alice.md", "Submissions/bob.txt", "Submissions/carol.pdf", "Submissions/empty.md"]);
		expect(notesUnder(vault, "Submissions").map((f) => f.path)).toContain("Submissions/sub/deeper.md");
		expect(notesUnder(vault, "Teaching/Rubrics").map((f) => f.basename)).toEqual(["Essay rubric"]);
	});

	it("joins paths and makes file names safe", () => {
		expect(joinPath("/Teaching/", "Grading", "Essay rubric")).toBe("Teaching/Grading/Essay rubric");
		expect(safeFileName('Essay 1: "draft" <final>?')).toBe("Essay 1 draft final");
		expect(safeFileName("///")).toBe("Untitled");
	});

	it("writeNote creates then overwrites", async () => {
		const v = new FakeVault();
		await writeNote(v, "A/b.md", "one");
		await writeNote(v, "A/b.md", "two");
		expect(await v.read("A/b.md")).toBe("two");
	});
});

describe("extractPdfPages", () => {
	it("joins text items into lines per page and caps the page count", async () => {
		const pdfjs: PdfJsLike = {
			getDocument: () => ({
				promise: Promise.resolve({
					numPages: 3,
					getPage: async (n: number) => ({
						getTextContent: async () => ({ items: [{ str: `Page ${n}` }, { str: "first", hasEOL: true }, { str: "second   line" }] }),
					}),
				}),
			}),
		};
		const out = await extractPdfPages(new Uint8Array(), pdfjs, 2);
		expect(out.numPages).toBe(3);
		expect(out.pages).toEqual(["Page 1 first\nsecond line", "Page 2 first\nsecond line"]);
	});
});
