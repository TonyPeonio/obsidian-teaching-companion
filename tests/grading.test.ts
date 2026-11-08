import { describe, expect, it } from "vitest";
import { REPLY_TOKENS_PER_CRITERION, criterionTokens, extractJson, gradeSubmission, gradingMessages, gradingUserMessage, parseGradingReply, planBatches } from "../src/core/grading";
import { parseRubric } from "../src/core/rubric";
import { estimateTokens, makeSubmission } from "../src/core/text";
import { ESSAY_RUBRIC, STRONG_ESSAY, fakeChat } from "./fakes";

const rubric = parseRubric(ESSAY_RUBRIC, "Essay rubric");
const strong = makeSubmission("alice", STRONG_ESSAY, "Submissions/alice.md");

const goodReply = JSON.stringify({
	criteria: [
		{ criterion: "Thesis", score: 5, justification: "The thesis is stated in the first sentence and argued throughout.", evidence: [{ quote: "Remote work raises productivity for knowledge workers", location: "paragraph 1" }] },
		{ criterion: "Evidence", score: 8, justification: "Two cited studies support the claim; the link is explained once.", evidence: [{ quote: "Bloom et al. (2015) found a 13% performance increase", location: "paragraph 2" }, { quote: "this sentence is not in the essay at all", location: "paragraph 9" }] },
		{ criterion: "Mechanics", score: 5, justification: "No errors interfere with reading.", evidence: [] },
	],
});

describe("extractJson", () => {
	it("accepts fenced JSON, prose around it and trailing commas", () => {
		expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
		expect(extractJson('Here you go: {"a":[1,2,],} thanks')).toEqual({ a: [1, 2] });
	});

	it("throws a GradingParseError when there is no JSON", () => {
		expect(() => extractJson("I cannot grade this.")).toThrow(/no JSON object/);
		expect(() => extractJson("{not json}")).toThrow(/not valid JSON/);
	});
});

describe("parseGradingReply", () => {
	it("keeps scores within range, keeps grounded quotes and drops ungrounded ones", () => {
		const { results, droppedQuotes } = parseGradingReply(goodReply, rubric.criteria, strong);
		expect(results.map((r) => r.proposed)).toEqual([5, 8, 5]);
		expect(results[0].quotes).toEqual([{ text: "Remote work raises productivity for knowledge workers", location: "¶ 1" }]);
		expect(results[1].quotes).toHaveLength(1);
		expect(results[1].quotes[0].location).toBe("¶ 2");
		expect(droppedQuotes).toBe(1);
		expect(results[1].flags).toEqual(["1 quote not found in the submission; dropped."]);
		expect(results[0].flags).toEqual([]);
	});

	it("matches quotes case-insensitively with normalised whitespace and curly quotes", () => {
		const reply = JSON.stringify({ criteria: [{ criterion: "Thesis", score: 4, justification: "ok", evidence: ["remote   work RAISES productivity for knowledge workers because it removes commuting"] }] });
		const { results, droppedQuotes } = parseGradingReply(reply, [rubric.criteria[0]], strong);
		expect(droppedQuotes).toBe(0);
		expect(results[0].quotes[0].location).toBe("¶ 1");
	});

	it("clamps out-of-range scores and flags them; non-numeric scores become 0", () => {
		const reply = JSON.stringify({
			criteria: [
				{ criterion: "Thesis", score: 7, justification: "Too generous.", evidence: [] },
				{ criterion: "Evidence", score: -2, justification: "Negative.", evidence: [] },
				{ criterion: "Mechanics", score: "n/a", justification: "Unclear.", evidence: [] },
			],
		});
		const { results } = parseGradingReply(reply, rubric.criteria, strong);
		expect(results.map((r) => r.proposed)).toEqual([5, 0, 0]);
		expect(results[0].flags[0]).toBe("Score 7 was outside 0–5; clamped to 5.");
		expect(results[1].flags[0]).toBe("Score -2 was outside 0–10; clamped to 0.");
		expect(results[2].flags[0]).toMatch(/No numeric score/);
	});

	it("reports criteria the model skipped as null and ignores extra ones", () => {
		const reply = JSON.stringify({ criteria: [{ criterion: "Thesis", score: 3, justification: "Broad.", evidence: [] }, { criterion: "Originality", score: 9, justification: "Not asked.", evidence: [] }] });
		const { results } = parseGradingReply(reply, rubric.criteria, strong);
		expect(results.map((r) => r.proposed)).toEqual([3, null, null]);
		expect(results[1].flags).toEqual(["Not scored by the model."]);
	});

	it("accepts alternative field names, string scores and a keyed object", () => {
		const reply = JSON.stringify({ Thesis: { points: "4 / 5", reason: "Fine.", quotes: ["Remote work raises productivity"] }, Evidence: { proposed: 6, rationale: "Some.", evidence: [] } });
		const { results } = parseGradingReply(reply, rubric.criteria.slice(0, 2), strong);
		expect(results.map((r) => r.proposed)).toEqual([4, 6]);
		expect(results[0].justification).toBe("Fine.");
		expect(results[0].quotes[0].text).toBe("Remote work raises productivity");
	});

	it("keeps at most three grounded quotes per criterion", () => {
		const quotes = ["Remote work raises productivity", "removes commuting", "most focused hours", "Bloom et al. (2015)", "patent examiners"];
		const reply = JSON.stringify({ criteria: [{ criterion: "Thesis", score: 5, justification: "ok", evidence: quotes }] });
		const { results, droppedQuotes } = parseGradingReply(reply, [rubric.criteria[0]], strong);
		expect(results[0].quotes).toHaveLength(3);
		expect(droppedQuotes).toBe(0);
	});
});

describe("prompt construction", () => {
	it("puts the criteria, levels, submission and the exact names in the user message", () => {
		const msg = gradingUserMessage(rubric, rubric.criteria, strong.text, "alice");
		expect(msg).toContain("- Thesis (0 to 5 points): States a clear, arguable thesis early.");
		expect(msg).toContain("    3: Adequate: present but broad.");
		expect(msg).toContain("<<<SUBMISSION\n" + strong.text + "\nSUBMISSION>>>");
		expect(msg).toContain('exactly 3 entries in "criteria", in the order given, using these names: "Thesis", "Evidence", "Mechanics"');
	});

	it("has a system prompt that demands JSON only and verbatim quotes", () => {
		const [system] = gradingMessages(rubric, rubric.criteria, strong.text, "alice");
		expect(system.role).toBe("system");
		expect(system.content).toMatch(/JSON only/);
		expect(system.content).toMatch(/verbatim/);
		expect(system.content).toContain('"criteria":[{"criterion"');
	});
});

describe("planBatches", () => {
	it("uses one call when everything fits", () => {
		const plan = planBatches(rubric, strong, 16384);
		expect(plan.batches).toHaveLength(1);
		expect(plan.batches[0].map((c) => c.name)).toEqual(["Thesis", "Evidence", "Mechanics"]);
		expect(plan.truncated).toBe(false);
		expect(plan.text).toBe(strong.text);
	});

	it("splits criteria into groups when the submission leaves little room", () => {
		// Budget = numCtx - 700 overhead. Leave room beside the submission for exactly the largest criterion.
		const sub = makeSubmission("long", "word ".repeat(384).trim(), "x");
		const numCtx = 700 + estimateTokens(sub.text) + Math.max(...rubric.criteria.map(criterionTokens));
		const plan = planBatches(rubric, sub, numCtx);
		expect(plan.truncated).toBe(false);
		expect(plan.batches.map((b) => b.map((c) => c.name))).toEqual([["Thesis"], ["Evidence"], ["Mechanics"]]);
	});

	it("groups two criteria per call when exactly two fit", () => {
		const sub = makeSubmission("s", "word ".repeat(400), "x");
		const costs = rubric.criteria.map(criterionTokens);
		const numCtx = 700 + estimateTokens(sub.text) + costs[0] + costs[1];
		const plan = planBatches(rubric, sub, numCtx);
		expect(plan.batches.map((b) => b.length)).toEqual([2, 1]);
	});

	it("truncates the submission when even one criterion does not fit beside it", () => {
		const sub = makeSubmission("huge", "line of text here\n".repeat(3000), "x");
		const plan = planBatches(rubric, sub, 2048);
		expect(plan.truncated).toBe(true);
		expect(estimateTokens(plan.text)).toBeLessThanOrEqual(2048 - 700 - Math.max(...rubric.criteria.map(criterionTokens)));
		expect(plan.batches.length).toBeGreaterThanOrEqual(1);
		expect(REPLY_TOKENS_PER_CRITERION).toBeGreaterThan(100);
	});
});

describe("gradeSubmission", () => {
	it("runs one call when the text fits and totals the validated scores", async () => {
		const { chat, prompts } = fakeChat([goodReply]);
		const result = await gradeSubmission(rubric, strong, chat, { numCtx: 16384 });
		expect(prompts).toHaveLength(1);
		expect(result.calls).toBe(1);
		expect(result.totalProposed).toBe(18);
		expect(result.totalMax).toBe(20);
		expect(result.droppedQuotes).toBe(1);
		expect(result.missingCriteria).toEqual([]);
	});

	it("runs one call per batch and stitches the results in rubric order", async () => {
		const sub = makeSubmission("s", "word ".repeat(400), "x");
		const costs = rubric.criteria.map(criterionTokens);
		const numCtx = 700 + estimateTokens(sub.text) + costs[0] + costs[1];
		const replies = [
			JSON.stringify({ criteria: [{ criterion: "Thesis", score: 2, justification: "a", evidence: [] }, { criterion: "Evidence", score: 3, justification: "b", evidence: [] }] }),
			JSON.stringify({ criteria: [{ criterion: "Mechanics", score: 4, justification: "c", evidence: [] }] }),
		];
		const { chat, prompts } = fakeChat(replies);
		const progress: [number, number][] = [];
		const result = await gradeSubmission(rubric, sub, chat, { numCtx, onProgress: (d, t) => progress.push([d, t]) });
		expect(prompts).toHaveLength(2);
		expect(prompts[1][1].content).toContain('using these names: "Mechanics"');
		expect(result.results.map((r) => [r.criterion, r.proposed])).toEqual([
			["Thesis", 2],
			["Evidence", 3],
			["Mechanics", 4],
		]);
		expect(result.totalProposed).toBe(9);
		expect(progress).toEqual([
			[0, 2],
			[1, 2],
			[2, 2],
		]);
	});

	it("lists missing criteria and refuses an empty rubric", async () => {
		const { chat } = fakeChat([JSON.stringify({ criteria: [{ criterion: "Thesis", score: 1, justification: "x", evidence: [] }] })]);
		const result = await gradeSubmission(rubric, strong, chat, { numCtx: 16384 });
		expect(result.missingCriteria).toEqual(["Evidence", "Mechanics"]);
		expect(result.totalProposed).toBe(1);
		await expect(gradeSubmission({ name: "e", criteria: [], totalMax: 0 }, strong, chat, { numCtx: 16384 })).rejects.toThrow(/no criteria/);
	});
});
