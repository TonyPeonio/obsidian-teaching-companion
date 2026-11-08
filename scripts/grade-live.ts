// Live check of the grading path against a real Ollama model: one rubric with three
// criteria, two short synthetic submissions (one strong, one weak), the plugin's own
// prompt, client and validator. Prints scores, dropped quotes and timing per submission.
// Passes when both replies parse and the weak submission scores lower than the strong one.
//
//   npm run grade:live
//   MODEL=qwen3.5:9b OLLAMA_URL=http://localhost:11434 npm run grade:live
//
// Budget: one model call per submission (2 in total). A connection failure waits 60 s and
// retries once, then stops. Prompts and replies land in .e2e/grade-live-out/ (git-ignored).
import { mkdirSync, writeFileSync } from "fs";
import * as path from "path";
import { gradeSubmission, gradingMessages, planBatches, type GradingResult } from "../src/core/grading";
import { renderGradingNote } from "../src/core/notes";
import { isConnectionError, OllamaClient } from "../src/core/ollama";
import { parseRubric } from "../src/core/rubric";
import { makeSubmission, type Submission } from "../src/core/text";

const MODEL = process.env.MODEL ?? "qwen3.5:9b";
const URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const NUM_CTX = Number(process.env.NUM_CTX ?? 16384);
const OUT_DIR = path.join(__dirname, "grade-live-out");

const RUBRIC = `---
total: 20
---
# Short answer rubric

| Criterion | Points | Description |
|---|---|---|
| Claim | 5 | States one clear, arguable claim in the first paragraph. |
| | 5 | Excellent: the claim is specific and arguable. |
| | 3 | Adequate: a claim is present but vague. |
| | 1 | Weak: no identifiable claim. |
| Evidence | 10 | Supports the claim with specific, cited evidence and explains how it supports the claim. |
| | 10 | Excellent: two or more cited findings, each tied to the claim. |
| | 6 | Adequate: one cited finding, or findings not tied to the claim. |
| | 2 | Weak: assertions without evidence. |
| Mechanics | 5 | Spelling and grammar do not get in the way of reading. |
`;

const STRONG = `Remote work raises productivity for knowledge workers because it removes commuting and lets people choose their most focused hours.

Bloom et al. (2015) found a 13% performance increase among call-centre staff who worked from home, and the effect persisted over nine months. This supports the claim because the staff did the same measurable tasks under both conditions.

A second study by Choudhury (2021) showed that patent examiners who could work from anywhere produced 4.4% more output. Together these findings show that flexibility, not merely location, drives the gain.

In short, the evidence points one way: well-supported remote work makes people more productive.
`;

const WEAK = `Remote work is good. Many people like it and it is popular now.

Some people say it helps and some say it doesnt. I think its fine. Their are lots of opinions on this and everyone has there own view.

In conclusion remote work is a thing that exists and people have views about it.
`;

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
	mkdirSync(OUT_DIR, { recursive: true });
	const client = new OllamaClient(() => URL);
	const rubric = parseRubric(RUBRIC, "Short answer rubric");
	const submissions: Submission[] = [makeSubmission("strong", STRONG, "synthetic"), makeSubmission("weak", WEAK, "synthetic")];
	let calls = 0;
	let retried = false;

	const chat = async (messages: Parameters<typeof client.chat>[0]["messages"]): Promise<string> => {
		for (;;) {
			calls++;
			try {
				const reply = await client.chat({ model: MODEL, messages, options: { num_ctx: NUM_CTX, temperature: 0.1 }, think: false, format: "json", keep_alive: "10m" });
				writeFileSync(path.join(OUT_DIR, `call-${calls}.json`), reply);
				return reply;
			} catch (err) {
				if (isConnectionError(err) && !retried) {
					retried = true;
					console.log(`  connection error (${(err as Error).message}); waiting 60 s and retrying once…`);
					await sleep(60_000);
					continue;
				}
				throw err;
			}
		}
	};

	console.log(`Model ${MODEL} at ${URL}, num_ctx ${NUM_CTX}`);
	console.log(`Rubric: ${rubric.criteria.map((c) => `${c.name}/${c.maxPoints}`).join(", ")} (total ${rubric.totalMax})`);
	const results: { name: string; result: GradingResult; ms: number }[] = [];
	for (const sub of submissions) {
		const plan = planBatches(rubric, sub, NUM_CTX);
		writeFileSync(path.join(OUT_DIR, `${sub.name}-prompt.txt`), gradingMessages(rubric, plan.batches[0], plan.text, sub.name).map((m) => `[${m.role}]\n${m.content}`).join("\n\n"));
		console.log(`\n${sub.name}: ${plan.batches.length} call(s), ${sub.text.length} chars`);
		const t0 = Date.now();
		const result = await gradeSubmission(rubric, sub, chat, { numCtx: NUM_CTX });
		const ms = Date.now() - t0;
		results.push({ name: sub.name, result, ms });
		for (const r of result.results) {
			console.log(`  ${r.criterion.padEnd(10)} ${String(r.proposed ?? "-").padStart(2)}/${r.max}  quotes ${r.quotes.length}${r.flags.length ? `  [${r.flags.join("; ")}]` : ""}`);
			for (const q of r.quotes) console.log(`      "${q.text.slice(0, 80)}${q.text.length > 80 ? "…" : ""}" (${q.location})`);
			if (r.justification) console.log(`      ${r.justification}`);
		}
		console.log(`  total ${result.totalProposed}/${result.totalMax}, dropped quotes ${result.droppedQuotes}, missing ${result.missingCriteria.length}, ${(ms / 1000).toFixed(1)} s`);
		writeFileSync(path.join(OUT_DIR, `${sub.name}.md`), renderGradingNote({ rubric, submission: sub, result, model: MODEL, date: new Date().toISOString().slice(0, 10), comments: { tone: "detailed", includeQuotes: true } }));
	}

	const strong = results[0].result;
	const weak = results[1].result;
	const checks: [string, boolean][] = [
		["both replies parsed with every criterion scored", strong.missingCriteria.length === 0 && weak.missingCriteria.length === 0],
		["weak scores lower than strong", weak.totalProposed < strong.totalProposed],
		["strong has at least one grounded quote", strong.results.some((r) => r.quotes.length > 0)],
		["total model calls within budget (≤ 6)", calls <= 6],
	];
	console.log("");
	for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
	console.log(`\n${calls} model call(s), ${results.reduce((s, r) => s + r.ms, 0) / 1000} s total. Output in ${OUT_DIR}`);
	if (checks.some(([, ok]) => !ok)) process.exit(1);
}

main().catch((err) => {
	console.error(`grade-live failed: ${(err as Error).message}`);
	process.exit(1);
});
