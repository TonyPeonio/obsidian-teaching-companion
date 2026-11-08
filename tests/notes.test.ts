import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "../src/core/frontmatter";
import { summarize, type CriterionResult } from "../src/core/grading";
import { BANNER, gradingNotePath, parseGradingNote, parseScoreCell, renderGradingNote, replaceSection, yourScoresOf } from "../src/core/notes";
import { parseRubric } from "../src/core/rubric";
import { makeSubmission } from "../src/core/text";
import { ESSAY_RUBRIC, STRONG_ESSAY } from "./fakes";

const rubric = parseRubric(ESSAY_RUBRIC, "Essay rubric");
const submission = makeSubmission("alice", STRONG_ESSAY, "Submissions/alice.md");

function results(): CriterionResult[] {
	return [
		{ criterion: "Thesis", proposed: 5, max: 5, justification: "The thesis is stated in the first sentence.", quotes: [{ text: "Remote work raises productivity for knowledge workers", location: "¶ 1" }], flags: [] },
		{ criterion: "Evidence", proposed: 8, max: 10, justification: "Two cited studies support the claim; one link is left implicit.", quotes: [{ text: "Bloom et al. (2015) found a 13% performance increase", location: "¶ 2" }], flags: ["1 quote not found in the submission; dropped."] },
		{ criterion: "Mechanics", proposed: 5, max: 5, justification: "No errors interfere | with reading.", quotes: [], flags: [] },
	];
}

const note = renderGradingNote({
	rubric,
	submission,
	result: summarize(results(), 1, false, 1),
	model: "qwen3.5:9b",
	date: "2026-11-07",
	comments: { tone: "brief", includeQuotes: false },
});

describe("renderGradingNote", () => {
	it("writes the frontmatter the grade book needs and the draft banner", () => {
		const { data } = parseFrontmatter(note);
		expect(data).toMatchObject({ rubric: "Essay rubric", submission: "alice", total_proposed: "18", total_max: "20", status: "draft", graded: "2026-11-07", model: "qwen3.5:9b" });
		expect(note).toContain(`> [!warning] ${BANNER}`);
	});

	it("has a scores table with an empty 'Your score' column and a total row", () => {
		expect(note).toContain("| Criterion | Proposed | Max | Your score | Justification |");
		expect(note).toContain("| Thesis | 5 | 5 |  | The thesis is stated in the first sentence. |");
		expect(note).toContain("| Mechanics | 5 | 5 |  | No errors interfere \\| with reading. |");
		expect(note).toContain("| **Total** | 18 | 20 | | |");
	});

	it("lists the evidence quotes with their locations and says when there are none", () => {
		expect(note).toContain('> "Remote work raises productivity for knowledge workers" — ¶ 1');
		expect(note).toMatch(/### Mechanics\n\n_No verbatim evidence was found for this criterion._/);
	});

	it("records dropped quotes and flags under Grading notes", () => {
		expect(note).toContain("- 1 quote the model offered was not found verbatim in the submission and was dropped.");
		expect(note).toContain("- Graded by qwen3.5:9b on 2026-11-07 in 1 model call; nothing left this machine.");
	});

	it("notes truncation and unscored criteria", () => {
		const rs = results();
		rs[2] = { ...rs[2], proposed: null, justification: "", flags: ["Not scored by the model."] };
		const n = renderGradingNote({ rubric, submission, result: summarize(rs, 0, true, 2), model: "m", date: "2026-11-07", comments: { tone: "brief", includeQuotes: false } });
		expect(n).toContain("- The submission was longer than the context window");
		expect(n).toContain("- Not scored by the model: Mechanics. Score these by hand.");
		expect(n).toContain("| Mechanics |  | 5 |  |  |");
		expect(n).toContain("total_proposed: 13");
	});
});

describe("parseGradingNote and the 'Your score' round-trip", () => {
	it("reads back the proposed scores with no final total while 'Your score' is empty", () => {
		const s = parseGradingNote(note);
		expect(s).not.toBeNull();
		expect(s?.rows.map((r) => [r.criterion, r.proposed, r.max, r.yourScore])).toEqual([
			["Thesis", 5, 5, null],
			["Evidence", 8, 10, null],
			["Mechanics", 5, 5, null],
		]);
		expect(s?.totalProposed).toBe(18);
		expect(s?.totalMax).toBe(20);
		expect(s?.complete).toBe(false);
		expect(s?.finalTotal).toBeNull();
	});

	it("picks up the scores the grader typed and sums them once every row has one", () => {
		const partial = note.replace("| Thesis | 5 | 5 |  |", "| Thesis | 5 | 5 | 4 |");
		const p = parseGradingNote(partial);
		expect(p?.rows[0].yourScore).toBe(4);
		expect(p?.complete).toBe(false);
		expect(p?.finalTotal).toBeNull();
		expect(yourScoresOf(p)).toEqual(new Map([["Thesis", 4]]));

		const full = partial.replace("| Evidence | 8 | 10 |  |", "| Evidence | 8 | 10 | 7/10 |").replace("| Mechanics | 5 | 5 |  |", "| Mechanics | 5 | 5 | 4.5 |");
		const f = parseGradingNote(full);
		expect(f?.complete).toBe(true);
		expect(f?.finalTotal).toBe(15.5);
	});

	it("carries previous 'Your score' values into a re-rendered note", () => {
		const previous = new Map([
			["Thesis", 4],
			["Evidence", 7],
		]);
		const again = renderGradingNote({ rubric, submission, result: summarize(results(), 0, false, 1), model: "m", date: "2026-11-08", comments: { tone: "brief", includeQuotes: false }, previousScores: previous });
		expect(again).toContain("| Thesis | 5 | 5 | 4 |");
		expect(again).toContain("| Evidence | 8 | 10 | 7 |");
		expect(again).toContain("| Mechanics | 5 | 5 |  |");
		expect(again).toContain("carried over from the previous grading note");
		expect(parseGradingNote(again)?.rows.map((r) => r.yourScore)).toEqual([4, 7, null]);
	});

	it("returns null for a note without a scores table and parses odd score cells", () => {
		expect(parseGradingNote("# Just a note\n\nhello\n")).toBeNull();
		expect(parseScoreCell("")).toBeNull();
		expect(parseScoreCell("**4**")).toBe(4);
		expect(parseScoreCell("3 pts")).toBe(3);
	});
});

describe("paths and sections", () => {
	it("builds the grading note path from safe names", () => {
		expect(gradingNotePath("Teaching/Grading", "Essay 1: rubric", "alice/smith.pdf")).toBe("Teaching/Grading/Essay 1 rubric/alice smith.pdf.md");
	});

	it("replaceSection replaces an existing section or appends a new one", () => {
		const base = "# R\n\n| a |\n|---|\n| b |\n";
		const once = replaceSection(base, "Suggestions", "- one");
		expect(once).toBe("# R\n\n| a |\n|---|\n| b |\n\n## Suggestions\n\n- one\n");
		const twice = replaceSection(once + "\n## After\n\nkeep\n", "Suggestions", "- two\n- three");
		expect(twice).toBe("# R\n\n| a |\n|---|\n| b |\n\n## Suggestions\n\n- two\n- three\n\n## After\n\nkeep\n");
	});
});
