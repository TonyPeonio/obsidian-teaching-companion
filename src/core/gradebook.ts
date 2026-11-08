/**
 * The grade book: one note per rubric, rebuilt from the grading notes in its folder.
 * Everything here is arithmetic over parsed notes, so the same notes always give the same
 * grade book (the `updated` date aside).
 */

import { parseFrontmatter, renderFrontmatter } from "./frontmatter";
import type { GradingNoteSummary } from "./notes";
import type { Rubric } from "./rubric";
import { escapeCell, formatNumber } from "./text";

export const GRADE_BOOK_NAME = "Grade book";

export interface GradeRecord {
	/** Vault path of the grading note. */
	path: string;
	/** Note basename, used for the link. */
	basename: string;
	summary: GradingNoteSummary;
}

export interface CriterionAverage {
	name: string;
	max: number;
	/** Mean proposed score over the submissions that have one. */
	avgProposed: number | null;
	/** Mean "Your score" over the submissions that have one; null when none do. */
	avgFinal: number | null;
	/** Mean effective (final where present, else proposed) score as a percentage of max. */
	pct: number | null;
	count: number;
}

/** Final total when the grader finished the note, the proposed total otherwise. */
export function effectiveTotal(s: GradingNoteSummary): number {
	return s.finalTotal ?? s.totalProposed;
}

export function percent(value: number, max: number): number {
	return max > 0 ? (value / max) * 100 : 0;
}

/** 0–9% → 0, 10–19% → 1, …, 90–100% → 9. */
export function band(pct: number): number {
	return Math.min(9, Math.max(0, Math.floor(pct / 10)));
}

export function bandLabel(i: number): string {
	return i === 9 ? "90–100%" : `${i * 10}–${i * 10 + 9}%`;
}

/** Count per 10% band of the effective totals. */
export function distribution(records: GradeRecord[]): number[] {
	const counts = new Array<number>(10).fill(0);
	for (const r of records) {
		if (r.summary.totalMax <= 0) continue;
		counts[band(percent(effectiveTotal(r.summary), r.summary.totalMax))]++;
	}
	return counts;
}

export function criterionAverages(records: GradeRecord[], order: string[]): CriterionAverage[] {
	const names = [...order];
	for (const r of records) for (const row of r.summary.rows) if (!names.some((n) => sameName(n, row.criterion))) names.push(row.criterion);
	return names.map((name) => {
		let max = 0;
		const proposed: number[] = [];
		const finals: number[] = [];
		const effective: number[] = [];
		for (const r of records) {
			const row = r.summary.rows.find((x) => sameName(x.criterion, name));
			if (!row) continue;
			max = Math.max(max, row.max);
			if (row.proposed !== null) proposed.push(row.proposed);
			if (row.yourScore !== null) finals.push(row.yourScore);
			const eff = row.yourScore ?? row.proposed;
			if (eff !== null) effective.push(eff);
		}
		return {
			name,
			max,
			avgProposed: mean(proposed),
			avgFinal: mean(finals),
			pct: effective.length && max > 0 ? percent(mean(effective) ?? 0, max) : null,
			count: effective.length,
		};
	});
}

/** Criteria with the lowest average percentage, worst first; ties by name. */
export function mostMissed(averages: CriterionAverage[], limit = 3): CriterionAverage[] {
	return averages
		.filter((a) => a.pct !== null && a.count > 0)
		.sort((a, b) => (a.pct ?? 0) - (b.pct ?? 0) || a.name.localeCompare(b.name))
		.slice(0, limit);
}

export function renderGradeBook(rubricName: string, rubric: Rubric | null, records: GradeRecord[], date: string): string {
	const sorted = [...records].sort((a, b) => a.basename.localeCompare(b.basename));
	const out: string[] = [];
	out.push(renderFrontmatter({ rubric: rubricName, submissions: String(sorted.length), updated: date }));
	out.push("");
	out.push(`# ${GRADE_BOOK_NAME}: ${rubricName}`);
	out.push("");
	out.push("Built from the grading notes in this folder. Final totals come from the \"Your score\" column; a note with any empty \"Your score\" is a draft and its proposed total is used in the statistics. Run **Grade book** again after editing scores; only this note is rewritten.");
	out.push("");
	out.push("## Submissions");
	out.push("");
	if (sorted.length === 0) {
		out.push("_No grading notes yet. Run **Grade a submission** or **Grade a folder** with this rubric._");
		out.push("");
		return out.join("\n");
	}
	out.push("| Submission | Proposed | Final | % | Status |");
	out.push("|---|---|---|---|---|");
	for (const r of sorted) {
		const s = r.summary;
		const pct = s.totalMax > 0 ? `${Math.round(percent(effectiveTotal(s), s.totalMax))}%` : "";
		// Full path with an alias: the same student name recurs across rubrics, so a bare basename could resolve elsewhere.
		out.push(`| [[${escapeCell(r.path.replace(/\.md$/, ""))}\\|${escapeCell(r.basename)}]] | ${formatNumber(s.totalProposed)} / ${formatNumber(s.totalMax)} | ${s.finalTotal === null ? "" : `${formatNumber(s.finalTotal)} / ${formatNumber(s.totalMax)}`} | ${pct} | ${s.complete ? "final" : "draft"} |`);
	}
	out.push("");
	const totals = sorted.map((r) => effectiveTotal(r.summary));
	const maxes = sorted.map((r) => r.summary.totalMax);
	const pcts = sorted.filter((r) => r.summary.totalMax > 0).map((r) => percent(effectiveTotal(r.summary), r.summary.totalMax));
	const finals = sorted.filter((r) => r.summary.complete).length;
	const sameMax = maxes.every((m) => m === maxes[0]);
	const meanTotal = mean(totals) ?? 0;
	out.push(`${sorted.length} submission${sorted.length === 1 ? "" : "s"}, ${finals} final. Mean ${formatNumber(round2(meanTotal))}${sameMax ? ` / ${formatNumber(maxes[0])}` : ""} (${Math.round(mean(pcts) ?? 0)}%), median ${Math.round(median(pcts) ?? 0)}%.`);
	out.push("");
	out.push("## Criteria");
	out.push("");
	const averages = criterionAverages(sorted, rubric?.criteria.map((c) => c.name) ?? []);
	out.push("| Criterion | Max | Avg proposed | Avg final | Avg % |");
	out.push("|---|---|---|---|---|");
	for (const a of averages) {
		out.push(`| ${escapeCell(a.name)} | ${formatNumber(a.max)} | ${a.avgProposed === null ? "" : formatNumber(round2(a.avgProposed))} | ${a.avgFinal === null ? "" : formatNumber(round2(a.avgFinal))} | ${a.pct === null ? "" : `${Math.round(a.pct)}%`} |`);
	}
	out.push("");
	out.push("## Distribution");
	out.push("");
	const dist = distribution(sorted);
	out.push(dist.map((n, i) => `${bandLabel(i)}: ${n}`).join(" · "));
	out.push("");
	out.push("## Most missed");
	out.push("");
	const missed = mostMissed(averages);
	if (missed.length === 0) out.push("_No scored criteria yet._");
	for (const [i, a] of missed.entries()) out.push(`${i + 1}. ${a.name} — ${Math.round(a.pct ?? 0)}% on average over ${a.count} submission${a.count === 1 ? "" : "s"}`);
	out.push("");
	return out.join("\n");
}

/** True when a note is a grade book (so folder scans skip it). */
export function isGradeBook(content: string, basename: string): boolean {
	if (basename === GRADE_BOOK_NAME) return true;
	const { data } = parseFrontmatter(content);
	return typeof data.submissions === "string" && typeof data.rubric === "string" && !("submission" in data);
}

function sameName(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function mean(xs: number[]): number | null {
	return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}

export function median(xs: number[]): number | null {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}
