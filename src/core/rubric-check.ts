/**
 * Rubric check: the deterministic pre-check (missing descriptions, points that do not add
 * up) plus an optional model pass that looks for overlapping criteria and descriptions a
 * grader cannot observe. Both land under `## Suggestions` in the rubric note.
 */

import { criterionText, extractJson, GradingParseError } from "./grading";
import { replaceSection } from "./notes";
import type { ChatMessage } from "./ollama";
import type { Rubric, RubricIssue } from "./rubric";

export function rubricCheckMessages(rubric: Rubric): ChatMessage[] {
	const system = [
		"You review grading rubrics for teaching assistants. Be concrete and brief.",
		"Look for: criteria that overlap (the same quality scored twice), descriptions that are not observable (a grader could not point to evidence for them), levels that do not differ in a checkable way, and criteria whose points seem out of proportion.",
		"Do not rewrite the rubric. Give at most 6 suggestions, each one sentence naming the criterion it concerns. If the rubric is fine, return an empty list.",
		'Reply with JSON only, no prose and no code fences: {"suggestions":["<one sentence>", "..."]}',
	].join("\n");
	const user = [`Rubric: ${rubric.name}`, rubric.statedTotal !== undefined ? `Stated total: ${rubric.statedTotal}` : "", "", "Criteria:", ...rubric.criteria.map(criterionText)].filter((l, i) => l !== "" || i > 1).join("\n");
	return [
		{ role: "system", content: system },
		{ role: "user", content: user },
	];
}

/** Suggestions from the model: a JSON list, or bullet lines when the model ignored the format. */
export function parseSuggestions(reply: string): string[] {
	try {
		const json = extractJson(reply) as Record<string, unknown> | unknown[];
		const list = Array.isArray(json) ? json : json.suggestions;
		if (Array.isArray(list)) return list.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean).slice(0, 8);
	} catch (err) {
		if (!(err instanceof GradingParseError)) throw err;
	}
	const lines = reply.split(/\r?\n/).map((l) => l.trim());
	const bullets = lines.filter((l) => /^(?:[-*•]|\d+[.)])\s+/.test(l)).map((l) => l.replace(/^(?:[-*•]|\d+[.)])\s+/, "").trim());
	const candidates = bullets.length ? bullets : lines;
	return candidates.filter((l) => l.length > 15 && !/^```/.test(l) && !/:$/.test(l)).slice(0, 8);
}

export function renderSuggestions(issues: RubricIssue[], suggestions: string[] | null, model: string | null, date: string): string {
	const out: string[] = [];
	out.push("### Checks");
	out.push("");
	if (issues.length === 0) out.push("- Every criterion has points and a description; points add up.");
	for (const i of issues) out.push(`- ${i.criterion ? `**${i.criterion}**: ` : ""}${i.message}`);
	out.push("");
	out.push(`### From the model${model ? ` (${model}, ${date})` : ""}`);
	out.push("");
	if (suggestions === null) out.push("_The model was not asked (Ollama unreachable or the check was run without it)._");
	else if (suggestions.length === 0) out.push("- No overlap or unobservable description found.");
	else for (const s of suggestions) out.push(`- ${s}`);
	return out.join("\n");
}

export function writeSuggestions(content: string, issues: RubricIssue[], suggestions: string[] | null, model: string | null, date: string): string {
	return replaceSection(content, "Suggestions", renderSuggestions(issues, suggestions, model, date));
}
