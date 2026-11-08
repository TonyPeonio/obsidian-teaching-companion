import { describe, expect, it } from "vitest";
import { parseRubric, precheckRubric } from "../src/core/rubric";
import { criterionLine, parseOutlineRubric } from "../src/core/rubric-outline";
import { ESSAY_RUBRIC } from "./fakes";

/** Pasted from a course page: three-space indents, parenthesised points, a trailing sentence. */
const PROJECT_REPORT = `Essay 1 Rubric
Each row is a criterion; rows with an empty Criterion cell are score levels for the criterion above. Keep descriptions observable (what a grader can point to in the work). Grade with Grade a submission.

* Title page (5 points)
   * Project info, tile of the project you are working on
* Introduction (20 points)
   * The problem you solve, and why you chose that problem
   * Any necessary background info needed for your reader to understand the problem
   * A description of what constitutes "success," i.e., would motivate someone to buy/apply the product
* Technical Details (40 points)
   * The dataset(s) you are using - be specific about what the input (features) and outputs (data) are, and provide an example
   * The model(s) you are working with - give details as much as possible. Use visuals if helpful. DO NOT INCLUDE YOUR CODE.
   * Info on data wrangling and/or cleaning if it applies
   * Info on model training
      * Feature learning, if any (and why it was or wasn't used)
      * Splitting of data into sets: Train/validation/test, k-fold cross-validation, or something else
   * Model performance results
      * Screenshot your submission on Kaggle.com, or visualize your results.
      * Present the evaluation scores or other assessments. Go beyond just numbers. Use visuals - line plots, bar plots, etc.
      * Show the progress of your model. Show how the performance of your model improves with model tuning or iterations. What have you done during the process?
* Challenges and Conclusion (20 points)
   * Did you achieve what you'd hoped? Why or why not? What would you have done differently? What would you have done next?
   * What have you learned during the process?
* Acknowledgment and References (5 points)
   * Give credit to those works and resources you used.

There will be 10 points for overall evaluations (writing, grammar, spelling, and overall quality of your work).
`;

const HEADING_STYLE = `---
total: 15
---
# Lab report

## Method (10 points)

Every step can be repeated from the text alone.

- 10 — Excellent: quantities, order and apparatus are all given.
- 6 — Adequate: most steps are given; some quantities are missing.
- 2 — Weak: the method cannot be followed.

## Results: 5 pts

- Figures are labelled and referred to in the text
- Units on every axis

## Notes for graders

Ignore formatting when the student used the template.
`;

describe("outline rubric: bullets with points", () => {
	const rubric = parseRubric(PROJECT_REPORT, "Essay 1 Rubric");

	it("turns each top-level bullet with points into a criterion, plus the trailing points sentence", () => {
		expect(rubric.criteria.map((c) => c.name)).toEqual(["Title page", "Introduction", "Technical Details", "Challenges and Conclusion", "Acknowledgment and References", "Overall evaluations"]);
		expect(rubric.criteria.map((c) => c.maxPoints)).toEqual([5, 20, 40, 20, 5, 10]);
		expect(rubric.totalMax).toBe(100);
		expect(rubric.statedTotal).toBeUndefined();
	});
	it("flattens the nested bullets into the description, including deeper levels", () => {
		const tech = rubric.criteria[2];
		expect(tech.description).toContain("The dataset(s) you are using");
		expect(tech.description).toContain("DO NOT INCLUDE YOUR CODE.");
		expect(tech.description).toContain("k-fold cross-validation");
		expect(tech.description).toContain("Show the progress of your model.");
		expect(tech.levels).toEqual([]);
		expect(rubric.criteria[0].description).toBe("Project info, tile of the project you are working on.");
		expect(rubric.criteria[5].description).toMatch(/^There will be 10 points for overall evaluations/);
	});
	it("passes the pre-check: every criterion has points and a description", () => {
		expect(precheckRubric(rubric)).toEqual([]);
	});
	it("ignores the intro paragraph and the title line", () => {
		expect(rubric.criteria.some((c) => /Essay 1 Rubric|Each row is a criterion/.test(c.name + c.description))).toBe(false);
	});
});

describe("outline rubric: headings with points", () => {
	const rubric = parseRubric(HEADING_STYLE, "Lab report");

	it("reads a heading with points as a criterion and the lines under it as the description", () => {
		expect(rubric.criteria.map((c) => c.name)).toEqual(["Method", "Results"]);
		expect(rubric.criteria.map((c) => c.maxPoints)).toEqual([10, 5]);
		expect(rubric.criteria[0].description).toBe("Every step can be repeated from the text alone.");
		expect(rubric.criteria[1].description).toBe("Figures are labelled and referred to in the text. Units on every axis.");
	});
	it("reads nested items that start with a number as score levels, highest first", () => {
		expect(rubric.criteria[0].levels.map((l) => l.points)).toEqual([10, 6, 2]);
		expect(rubric.criteria[0].levels[1].description).toBe("Adequate: most steps are given; some quantities are missing.");
	});
	it("stops at a heading without points and checks the stated total", () => {
		expect(rubric.criteria.some((c) => /Notes for graders|Ignore formatting/.test(c.name + c.description))).toBe(false);
		expect(rubric.statedTotal).toBe(15);
		expect(precheckRubric(rubric)).toEqual([]);
	});
});

describe("outline rubric: edge cases", () => {
	it("is not used when the note has a criteria table", () => {
		const withStray = ESSAY_RUBRIC + "\n\n* Bonus (3 points)\n   * Extra credit\n";
		expect(parseRubric(withStray, "Essay").criteria.map((c) => c.name)).toEqual(["Thesis", "Evidence", "Mechanics"]);
	});
	it("lists top-level bullets without any points as criteria so the pre-check can flag them", () => {
		const rubric = parseRubric("# Draft\n\n- Thesis\n  - Clear and arguable\n- Evidence\n", "Draft");
		expect(rubric.criteria.map((c) => c.name)).toEqual(["Thesis", "Evidence"]);
		expect(rubric.criteria[0].description).toBe("Clear and arguable.");
		expect(precheckRubric(rubric).map((i) => i.message)).toContain("Has no points.");
	});
	it("takes an inline description after a colon or dash and strips bold", () => {
		expect(criterionLine("**Thesis** (5 pts): clear and arguable")).toEqual({ name: "Thesis", points: 5, description: "clear and arguable" });
		expect(criterionLine("Evidence - 10 points")).toEqual({ name: "Evidence", points: 10, description: "" });
		expect(criterionLine("Mechanics [5]")).toEqual({ name: "Mechanics", points: 5, description: "" });
		expect(criterionLine("Essay (2 pages)")).toEqual({ name: "Essay (2 pages)", points: undefined, description: "" });
	});
	it("skips fenced code and returns nothing for prose without points", () => {
		expect(parseOutlineRubric("Some notes.\n\n```\n* Fake (5 points)\n```\n")).toEqual([]);
	});
});
