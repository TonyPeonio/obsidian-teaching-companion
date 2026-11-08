import { describe, expect, it } from "vitest";
import { band, bandLabel, criterionAverages, distribution, isGradeBook, median, mostMissed, renderGradeBook, type GradeRecord } from "../src/core/gradebook";
import { summarize, type CriterionResult } from "../src/core/grading";
import { parseGradingNote, renderGradingNote } from "../src/core/notes";
import { parseRubric } from "../src/core/rubric";
import { makeSubmission } from "../src/core/text";
import { ESSAY_RUBRIC } from "./fakes";

const rubric = parseRubric(ESSAY_RUBRIC, "Essay rubric");

/** A grading note for `name` with the given proposed scores and optional typed scores. */
function note(name: string, proposed: [number, number, number], yours?: [number, number, number]): GradeRecord {
	const results: CriterionResult[] = rubric.criteria.map((c, i) => ({ criterion: c.name, proposed: proposed[i], max: c.maxPoints, justification: "j", quotes: [], flags: [] }));
	const previousScores = yours ? new Map(rubric.criteria.map((c, i) => [c.name, yours[i]])) : undefined;
	const content = renderGradingNote({ rubric, submission: makeSubmission(name, "text", "x"), result: summarize(results, 0, false, 1), model: "m", date: "2026-11-07", comments: { tone: "brief", includeQuotes: false }, previousScores });
	const summary = parseGradingNote(content);
	if (!summary) throw new Error("note did not parse");
	return { path: `Teaching/Grading/Essay rubric/${name}.md`, basename: name, summary };
}

// Fixed set: alice final 18/20 (90%), bob draft 11/20 (55%), carol final 14/20 (70%), dave draft 4/20 (20%).
const records = [note("alice", [5, 8, 5], [5, 8, 5]), note("bob", [3, 5, 3]), note("carol", [4, 7, 4], [4, 6, 4]), note("dave", [1, 2, 1])];

describe("grade book maths", () => {
	it("uses the final total when complete and the proposed total otherwise", () => {
		expect(records.map((r) => r.summary.finalTotal)).toEqual([18, null, 14, null]);
		expect(records.map((r) => r.summary.complete)).toEqual([true, false, true, false]);
	});

	it("averages each criterion over proposed, final and effective scores", () => {
		const avg = criterionAverages(records, rubric.criteria.map((c) => c.name));
		expect(avg.map((a) => a.name)).toEqual(["Thesis", "Evidence", "Mechanics"]);
		expect(avg[0]).toMatchObject({ max: 5, avgProposed: 3.25, avgFinal: 4.5, count: 4 });
		// Evidence effective: 8 (final), 5, 6 (final), 2 → mean 5.25 of 10 = 52.5%
		expect(avg[1].pct).toBeCloseTo(52.5);
		expect(avg[1].avgFinal).toBe(7);
	});

	it("ranks the most-missed criteria by average percentage, worst first", () => {
		const missed = mostMissed(criterionAverages(records, []), 2);
		expect(missed.map((a) => a.name)).toEqual(["Evidence", "Mechanics"]);
	});

	it("median handles odd and even counts", () => {
		expect(median([3, 1, 2])).toBe(2);
		expect(median([1, 2, 3, 4])).toBe(2.5);
		expect(median([])).toBeNull();
	});
});

describe("distribution bands", () => {
	it("maps percentages to ten bands with 100% in the top one", () => {
		expect([band(0), band(9.9), band(10), band(55), band(89.9), band(90), band(100), band(120)]).toEqual([0, 0, 1, 5, 8, 9, 9, 9]);
		expect(bandLabel(0)).toBe("0–9%");
		expect(bandLabel(5)).toBe("50–59%");
		expect(bandLabel(9)).toBe("90–100%");
	});

	it("counts the fixed set into its bands", () => {
		// 90%, 55%, 70%, 20%
		expect(distribution(records)).toEqual([0, 0, 1, 0, 0, 1, 0, 1, 0, 1]);
	});
});

describe("renderGradeBook", () => {
	const book = renderGradeBook("Essay rubric", rubric, records, "2026-11-07");

	it("lists submissions alphabetically with proposed, final, percent and status", () => {
		const link = (name: string) => `[[Teaching/Grading/Essay rubric/${name}\\|${name}]]`;
		expect(book).toContain(`| ${link("alice")} | 18 / 20 | 18 / 20 | 90% | final |`);
		expect(book).toContain(`| ${link("bob")} | 11 / 20 |  | 55% | draft |`);
		expect(book).toContain(`| ${link("carol")} | 15 / 20 | 14 / 20 | 70% | final |`);
		expect(book).toContain(`| ${link("dave")} | 4 / 20 |  | 20% | draft |`);
		expect(book.indexOf(link("alice"))).toBeLessThan(book.indexOf(link("bob")));
	});

	it("writes the summary line, the criteria table, the distribution line and the most-missed list", () => {
		expect(book).toContain("4 submissions, 2 final. Mean 11.75 / 20 (59%), median 63%.");
		expect(book).toContain("| Thesis | 5 | 3.25 | 4.5 | 65% |");
		expect(book).toContain("0–9%: 0 · 10–19%: 0 · 20–29%: 1 · 30–39%: 0 · 40–49%: 0 · 50–59%: 1 · 60–69%: 0 · 70–79%: 1 · 80–89%: 0 · 90–100%: 1");
		expect(book).toMatch(/## Most missed\n\n1\. Evidence — 53% on average over 4 submissions\n2\. Mechanics — 65%/);
	});

	it("is deterministic regardless of input order", () => {
		const shuffled = [records[2], records[0], records[3], records[1]];
		expect(renderGradeBook("Essay rubric", rubric, shuffled, "2026-11-07")).toBe(book);
	});

	it("has frontmatter and handles an empty folder", () => {
		expect(book.startsWith("---\nrubric: Essay rubric\nsubmissions: 4\nupdated: 2026-11-07\n---\n")).toBe(true);
		const empty = renderGradeBook("Essay rubric", rubric, [], "2026-11-07");
		expect(empty).toContain("_No grading notes yet.");
		expect(empty).not.toContain("## Criteria");
	});

	it("is recognised as a grade book so a rescan skips it", () => {
		expect(isGradeBook(book, "Grade book")).toBe(true);
		expect(isGradeBook(book, "Renamed")).toBe(true);
		const grading = renderGradingNote({ rubric, submission: makeSubmission("z", "t", "x"), result: summarize([], 0, false, 1), model: "m", date: "2026-11-07", comments: { tone: "brief", includeQuotes: false } });
		expect(isGradeBook(grading, "z")).toBe(false);
	});
});
