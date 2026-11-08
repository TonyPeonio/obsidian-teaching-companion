import { describe, expect, it } from "vitest";
import { parseRubric, precheckRubric } from "../src/core/rubric";
import { parseSuggestions, rubricCheckMessages, writeSuggestions } from "../src/core/rubric-check";
import { ESSAY_RUBRIC } from "./fakes";

const rubric = parseRubric(ESSAY_RUBRIC, "Essay rubric");

describe("rubric check", () => {
	it("builds a prompt that lists every criterion and asks for JSON", () => {
		const [system, user] = rubricCheckMessages(rubric);
		expect(system.content).toContain('{"suggestions":[');
		expect(user.content).toContain("Stated total: 20");
		expect(user.content).toContain("- Evidence (0 to 10 points)");
		expect(user.content).toContain("    1: Weak: no identifiable thesis.");
	});

	it("parses a JSON list, and falls back to bullet lines", () => {
		expect(parseSuggestions('{"suggestions":["Thesis and Evidence both reward argument quality.", "  "]}')).toEqual(["Thesis and Evidence both reward argument quality."]);
		expect(parseSuggestions("Here are my thoughts:\n- Mechanics has no observable levels to point at.\n2) Evidence could say how many sources count as enough.\n- ok")).toEqual([
			"Mechanics has no observable levels to point at.",
			"Evidence could say how many sources count as enough.",
		]);
		expect(parseSuggestions('{"suggestions":[]}')).toEqual([]);
	});

	it("writes checks and model suggestions under ## Suggestions, replacing an earlier run", () => {
		const note = ESSAY_RUBRIC.replace("| Mechanics | 5 | Grammar and spelling do not get in the way. |", "| Mechanics | 5 | |");
		const parsed = parseRubric(note, "Essay rubric");
		const issues = precheckRubric(parsed);
		const first = writeSuggestions(note, issues, ["Thesis and Evidence overlap on argument quality."], "qwen3.5:9b", "2026-11-07");
		expect(first).toContain("## Suggestions\n\n### Checks\n\n- **Mechanics**: Has no description; a grader cannot tell what to look for.\n\n### From the model (qwen3.5:9b, 2026-11-07)\n\n- Thesis and Evidence overlap on argument quality.");
		expect(parseRubric(first, "Essay rubric").criteria).toHaveLength(3);

		const second = writeSuggestions(first, [], null, null, "2026-11-08");
		expect(second.match(/## Suggestions/g)).toHaveLength(1);
		expect(second).toContain("- Every criterion has points and a description; points add up.");
		expect(second).toContain("_The model was not asked");
		expect(second).not.toContain("overlap on argument quality");
	});
});
