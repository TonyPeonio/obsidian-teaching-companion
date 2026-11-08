import { describe, expect, it } from "vitest";
import { addressStudent, draftComment, nextLevel, stripScores } from "../src/core/comments";
import type { CriterionResult } from "../src/core/grading";
import { parseRubric } from "../src/core/rubric";
import { ESSAY_RUBRIC } from "./fakes";

const rubric = parseRubric(ESSAY_RUBRIC, "Essay rubric");
const thesis = rubric.criteria[0];

const partial: CriterionResult = {
	criterion: "Thesis",
	proposed: 3,
	max: 5,
	justification: "The student's thesis is present but broad, so it scores 3/5.",
	quotes: [{ text: "Remote work is good.", location: "¶ 1" }],
	flags: [],
};

describe("stripScores", () => {
	it("removes fractions, 'out of', 'N points' and 'score of N' phrasing", () => {
		expect(stripScores("Clear thesis, 4/5.")).toBe("Clear thesis.");
		expect(stripScores("The argument earns 8 out of 10 points because it is well supported.")).toBe("The argument because it is well supported.");
		expect(stripScores("Good work, a score of 5 is warranted.")).toBe("Good work, is warranted.");
		expect(stripScores("This deserves full marks.")).toBe("This deserves.");
		expect(stripScores("Mechanics are fine (5 points).")).toBe("Mechanics are fine.");
	});

	it("leaves ordinary numbers in place and ends with a period", () => {
		expect(stripScores("Cites 2 studies from 2015 and 2021")).toBe("Cites 2 studies from 2015 and 2021.");
	});
});

describe("draftComment", () => {
	it("brief tone: one sentence addressed to the student with no score", () => {
		const c = draftComment(partial, thesis, { tone: "brief", includeQuotes: false });
		expect(c).toBe("Your thesis is present but broad, so it.");
		expect(c).not.toMatch(/\d\s*\/\s*\d/);
		expect(c).not.toMatch(/\bscores?\b/);
	});

	it("brief tone with quotes appends the first quote in parentheses", () => {
		const c = draftComment(partial, thesis, { tone: "brief", includeQuotes: true });
		expect(c).toContain('(See: "Remote work is good.".)');
	});

	it("detailed tone adds the quote and the next rubric level, without the level label", () => {
		const c = draftComment(partial, thesis, { tone: "detailed", includeQuotes: true });
		expect(c).toContain('For example, you wrote: "Remote work is good."');
		expect(c).toContain("To strengthen this: specific, arguable, guides the essay.");
		expect(c).not.toContain("Excellent:");
		expect(nextLevel(partial, thesis)).toBe("Specific, arguable, guides the essay.");
	});

	it("congratulates full marks and gives no next level", () => {
		const full = { ...partial, proposed: 5, justification: "The thesis is specific and guides the essay." };
		const c = draftComment(full, thesis, { tone: "detailed", includeQuotes: false });
		expect(c.startsWith("Nicely done.")).toBe(true);
		expect(c).not.toContain("To strengthen");
		expect(nextLevel(full, thesis)).toBeUndefined();
	});

	it("explains when the model did not score the criterion and falls back when the justification is empty", () => {
		expect(draftComment({ ...partial, proposed: null }, thesis, { tone: "brief", includeQuotes: true })).toMatch(/did not score/);
		expect(draftComment({ ...partial, justification: "" }, thesis, { tone: "brief", includeQuotes: false })).toBe("This part of the rubric looks at: States a clear, arguable thesis early.");
	});

	it("addresses the student instead of talking about them", () => {
		expect(addressStudent("The student cites sources; the submission is tidy; the author's voice is clear.")).toBe("you cites sources; your work is tidy; your voice is clear.");
	});
});
