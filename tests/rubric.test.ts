import { describe, expect, it } from "vitest";
import { parsePoints, parseRubric, precheckRubric, renderRubricTable, rubricTemplate, stripSection } from "../src/core/rubric";
import { ESSAY_RUBRIC } from "./fakes";

describe("parseRubric: single table with level rows", () => {
	const rubric = parseRubric(ESSAY_RUBRIC, "Essay rubric");

	it("finds the criteria in order with their points and descriptions", () => {
		expect(rubric.criteria.map((c) => c.name)).toEqual(["Thesis", "Evidence", "Mechanics"]);
		expect(rubric.criteria.map((c) => c.maxPoints)).toEqual([5, 10, 5]);
		expect(rubric.criteria[1].description).toBe("Supports claims with cited evidence and explains the link.");
	});

	it("attaches level rows (empty Criterion cell) to the criterion above, highest first", () => {
		expect(rubric.criteria[0].levels.map((l) => l.points)).toEqual([5, 3, 1]);
		expect(rubric.criteria[0].levels[1].description).toBe("Adequate: present but broad.");
		expect(rubric.criteria[2].levels).toEqual([]);
	});

	it("sums the total and reads the stated total from frontmatter", () => {
		expect(rubric.totalMax).toBe(20);
		expect(rubric.statedTotal).toBe(20);
		expect(precheckRubric(rubric)).toEqual([]);
	});
});

describe("parseRubric: one level table per criterion", () => {
	const note = `# Lab report rubric

Total: 15

### Method
| Level | Points | Description |
|---|---|---|
| Excellent | 5 | Every step is reproducible from the text. |
| Adequate | 3 | Most steps are given; some quantities missing. |
| Weak | 1 | The method cannot be followed. |

### Results

| Points | Description |
|---|---|
| 10 | Figures are labelled and the numbers match the text. |
| 5 | Figures present but hard to read. |
`;
	const rubric = parseRubric(note, "Lab report rubric");

	it("creates a criterion per heading and takes the max level as the points", () => {
		expect(rubric.criteria.map((c) => c.name)).toEqual(["Method", "Results"]);
		expect(rubric.criteria.map((c) => c.maxPoints)).toEqual([5, 10]);
	});

	it("prefixes the level name to the description and uses the top level as the criterion description", () => {
		expect(rubric.criteria[0].levels[0].description).toBe("Excellent: Every step is reproducible from the text.");
		expect(rubric.criteria[0].description).toBe("Excellent: Every step is reproducible from the text.");
		expect(rubric.criteria[1].levels.map((l) => l.points)).toEqual([10, 5]);
	});

	it("reads a 'Total:' line as the stated total and sums the criteria", () => {
		expect(rubric.statedTotal).toBe(15);
		expect(rubric.totalMax).toBe(15);
	});
});

describe("parseRubric: tolerance", () => {
	it("accepts loose header names, '5 pts', '0–5' and a Total row", () => {
		const note = `| Criteria | Pts | What to look for |
|---|---|---|
| Clarity | 5 pts | Easy to follow. |
| Depth | 0–10 | Goes beyond the obvious. |
| **Total** | 15 | |
`;
		const rubric = parseRubric(note, "x");
		expect(rubric.criteria.map((c) => [c.name, c.maxPoints])).toEqual([
			["Clarity", 5],
			["Depth", 10],
		]);
		expect(rubric.statedTotal).toBe(15);
		expect(parsePoints("/5")).toBe(5);
		expect(parsePoints("none")).toBeUndefined();
	});

	it("flags missing points and missing descriptions, and points that do not sum to the stated total", () => {
		const note = `---
total: 30
---
| Criterion | Points | Description |
|---|---|---|
| Thesis | | A thesis. |
| Style | 5 | |
| Length | 5 | About right. |
`;
		const rubric = parseRubric(note, "x");
		expect(rubric.criteria[0].maxPoints).toBe(0);
		const issues = precheckRubric(rubric);
		expect(issues.map((i) => i.message)).toEqual([
			"Has no points.",
			"Has no description; a grader cannot tell what to look for.",
			"Points sum to 10 but the note states a total of 30.",
		]);
		expect(issues[0].criterion).toBe("Thesis");
		expect(issues[1].criterion).toBe("Style");
	});

	it("flags duplicates and levels above the maximum", () => {
		const note = `| Criterion | Points | Description |
|---|---|---|
| Thesis | 5 | A thesis. |
| | 7 | Too generous. |
| thesis | 5 | Again. |
`;
		// The duplicate row merges into the first criterion, so "Appears more than once" is not raised;
		// the level above the max is.
		const rubric = parseRubric(note, "x");
		expect(rubric.criteria).toHaveLength(1);
		expect(precheckRubric(rubric).map((i) => i.message)).toEqual(["Level worth 7 exceeds the maximum of 5."]);
	});

	it("ignores tables under ## Suggestions and notes without any table", () => {
		const note = `${ESSAY_RUBRIC}\n## Suggestions\n\n| Criterion | Points | Description |\n|---|---|---|\n| Bogus | 99 | nope |\n`;
		expect(parseRubric(note, "x").criteria.map((c) => c.name)).toEqual(["Thesis", "Evidence", "Mechanics"]);
		const empty = parseRubric("# Nothing here\n\nJust prose.\n", "x");
		expect(empty.criteria).toEqual([]);
		expect(precheckRubric(empty)[0].message).toMatch(/No criteria found/);
	});

	it("stripSection removes a section up to the next heading of the same level", () => {
		const text = "# T\n\n## A\n\na\n\n## Suggestions\n\ns\n\n### sub\n\nx\n\n## B\n\nb\n";
		expect(stripSection(text, "Suggestions")).toBe("# T\n\n## A\n\na\n\n## B\n\nb\n");
	});
});

describe("rubric template and renderer", () => {
	it("writes a template that parses back to itself", () => {
		const content = rubricTemplate("Essay 1 rubric");
		const rubric = parseRubric(content, "Essay 1 rubric");
		expect(rubric.criteria.map((c) => c.name)).toEqual(["Thesis", "Evidence", "Mechanics"]);
		expect(rubric.totalMax).toBe(20);
		expect(rubric.statedTotal).toBe(20);
		expect(precheckRubric(rubric)).toEqual([]);
		expect(content).toContain("# Essay 1 rubric");
	});

	it("renders a table that round-trips through the parser", () => {
		const rubric = parseRubric(ESSAY_RUBRIC, "Essay rubric");
		const again = parseRubric(renderRubricTable(rubric), "Essay rubric");
		expect(again.criteria).toEqual(rubric.criteria);
		expect(again.statedTotal).toBe(20);
	});
});
