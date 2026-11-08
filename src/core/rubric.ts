/**
 * Rubrics are ordinary notes with a table. Two layouts are accepted:
 *
 *   | Criterion | Points | Description |          one row per criterion, optional level rows
 *   |---|---|---|                                 with an empty Criterion cell
 *   | Thesis | 5 | A clear, arguable thesis. |
 *   | | 5 | Excellent: specific and arguable. |
 *   | | 3 | Adequate: present but broad. |
 *
 *   ### Thesis                                    or one small table per criterion, under a
 *   | Points | Description |                      heading that names it
 *   |---|---|
 *   | 5 | Excellent: … |
 *
 * The parser is tolerant: header names are matched loosely, points may read "5 pts" or
 * "0–5", a "Total" row or a `total:` property states the expected total, and anything
 * under `## Suggestions` (written by the rubric check) is ignored.
 *
 * A note with no table is read as an outline (see rubric-outline.ts): top-level bullets or
 * headings carrying "(20 points)" are criteria, what is nested under them is the description.
 */

import { parseFrontmatter, renderFrontmatter } from "./frontmatter";
import { parseOutlineRubric } from "./rubric-outline";

export interface RubricLevel {
	points: number;
	description: string;
}

export interface Criterion {
	name: string;
	/** Maximum points; 0 when the note gives none (flagged by the pre-check). */
	maxPoints: number;
	description: string;
	/** Level descriptions from highest to lowest points; may be empty. */
	levels: RubricLevel[];
}

export interface Rubric {
	name: string;
	criteria: Criterion[];
	/** Sum of the criteria's maximum points. */
	totalMax: number;
	/** Total the note states (a `total:` property or a Total row), when it does. */
	statedTotal?: number;
}

export interface RubricIssue {
	criterion?: string;
	message: string;
}

const CRITERION_HEADERS = ["criterion", "criteria", "item", "name", "category", "dimension"];
const POINTS_HEADERS = ["points", "pts", "max", "max points", "score", "weight", "marks", "value"];
const DESCRIPTION_HEADERS = ["description", "desc", "details", "what to look for", "expectation", "expectations", "criteria description"];
const LEVEL_HEADERS = ["level", "rating", "band", "grade", "performance"];

interface Table {
	header: string[];
	rows: string[][];
	/** Text of the nearest heading above the table, "" when none. */
	heading: string;
}

export function parseRubric(content: string, name: string): Rubric {
	const { data, body } = parseFrontmatter(content);
	const text = stripSection(body, "Suggestions");
	const tables = findTables(text);
	const criteria: Criterion[] = [];
	let statedTotal: number | undefined;
	const fmTotal = typeof data.total === "string" ? parsePoints(data.total) : undefined;
	if (fmTotal !== undefined) statedTotal = fmTotal;
	else {
		const m = /^\s*(?:\*\*)?total(?: points)?(?:\*\*)?\s*:?\s*(?:\*\*)?\s*(\d+(?:\.\d+)?)/im.exec(text);
		if (m) statedTotal = Number(m[1]);
	}

	for (const table of tables) {
		const cols = columnIndexes(table.header);
		if (cols.criterion >= 0) {
			let current: Criterion | null = null;
			for (const row of table.rows) {
				const crit = cell(row, cols.criterion);
				const pts = cols.points >= 0 ? parsePoints(cell(row, cols.points)) : undefined;
				const desc = cols.description >= 0 ? cell(row, cols.description) : "";
				if (crit) {
					if (/^\**\s*total\s*\**$/i.test(crit)) {
						if (pts !== undefined) statedTotal = pts;
						current = null;
						continue;
					}
					current = findCriterion(criteria, crit) ?? addCriterion(criteria, crit);
					if (pts !== undefined) current.maxPoints = pts;
					if (desc) current.description = desc;
				} else if (current && (pts !== undefined || desc)) {
					current.levels.push({ points: pts ?? 0, description: levelText(cols.level >= 0 ? cell(row, cols.level) : "", desc) });
				}
			}
		} else if (cols.points >= 0 || cols.description >= 0) {
			// Level table: belongs to the criterion named by the heading above it.
			const heading = table.heading.trim();
			if (!heading) continue;
			const target = findCriterion(criteria, heading) ?? addCriterion(criteria, heading);
			for (const row of table.rows) {
				const pts = cols.points >= 0 ? parsePoints(cell(row, cols.points)) : undefined;
				const desc = cols.description >= 0 ? cell(row, cols.description) : "";
				if (pts === undefined && !desc) continue;
				target.levels.push({ points: pts ?? 0, description: levelText(cols.level >= 0 ? cell(row, cols.level) : "", desc) });
			}
		}
	}

	if (criteria.length === 0) criteria.push(...parseOutlineRubric(text));

	for (const c of criteria) {
		c.levels.sort((a, b) => b.points - a.points);
		if (c.maxPoints <= 0 && c.levels.length) c.maxPoints = Math.max(...c.levels.map((l) => l.points));
		if (!c.description && c.levels.length) c.description = c.levels[0].description;
	}
	const totalMax = criteria.reduce((s, c) => s + c.maxPoints, 0);
	return { name, criteria, totalMax, statedTotal };
}

/** Deterministic problems a grader should fix before trusting any model output. */
export function precheckRubric(rubric: Rubric): RubricIssue[] {
	const issues: RubricIssue[] = [];
	if (rubric.criteria.length === 0) issues.push({ message: "No criteria found. The note needs a table with Criterion, Points and Description columns, or an outline whose top-level bullets carry points, like `* Introduction (20 points)`." });
	const seen = new Set<string>();
	for (const c of rubric.criteria) {
		const key = normalizeName(c.name);
		if (seen.has(key)) issues.push({ criterion: c.name, message: "Appears more than once." });
		seen.add(key);
		if (c.maxPoints <= 0) issues.push({ criterion: c.name, message: "Has no points." });
		if (!c.description.trim()) issues.push({ criterion: c.name, message: "Has no description; a grader cannot tell what to look for." });
		for (const l of c.levels) {
			if (l.points > c.maxPoints) issues.push({ criterion: c.name, message: `Level worth ${l.points} exceeds the maximum of ${c.maxPoints}.` });
		}
	}
	if (rubric.statedTotal !== undefined && rubric.criteria.length && Math.abs(rubric.statedTotal - rubric.totalMax) > 1e-9) {
		issues.push({ message: `Points sum to ${rubric.totalMax} but the note states a total of ${rubric.statedTotal}.` });
	}
	return issues;
}

/** The single-table layout, with level rows when a criterion has levels. */
export function renderRubricTable(rubric: Rubric): string {
	const lines = ["| Criterion | Points | Description |", "|---|---|---|"];
	for (const c of rubric.criteria) {
		lines.push(`| ${esc(c.name)} | ${c.maxPoints} | ${esc(c.description)} |`);
		for (const l of c.levels) lines.push(`| | ${l.points} | ${esc(l.description)} |`);
	}
	lines.push(`| **Total** | ${rubric.totalMax} | |`);
	return lines.join("\n") + "\n";
}

export function rubricTemplate(name: string): string {
	const rubric: Rubric = {
		name,
		criteria: [
			{
				name: "Thesis",
				maxPoints: 5,
				description: "States a clear, arguable thesis early and keeps to it.",
				levels: [
					{ points: 5, description: "Excellent: the thesis is specific, arguable and guides the whole piece." },
					{ points: 3, description: "Adequate: a thesis is present but broad or drifts." },
					{ points: 1, description: "Weak: no identifiable thesis." },
				],
			},
			{
				name: "Evidence",
				maxPoints: 10,
				description: "Supports each claim with relevant, cited evidence and explains how it supports the claim.",
				levels: [
					{ points: 10, description: "Excellent: every claim is supported and the link is explained." },
					{ points: 6, description: "Adequate: most claims are supported; some evidence is left unexplained." },
					{ points: 2, description: "Weak: claims are asserted without support." },
				],
			},
			{ name: "Mechanics", maxPoints: 5, description: "Grammar, spelling and formatting do not get in the way of reading.", levels: [] },
		],
		totalMax: 20,
	};
	return (
		renderFrontmatter({ total: "20" }) +
		`# ${name}\n\n` +
		"Each row is a criterion; rows with an empty Criterion cell are score levels for the criterion above. " +
		"Keep descriptions observable (what a grader can point to in the work). Grade with **Grade a submission**.\n\n" +
		renderRubricTable(rubric)
	);
}

export function findCriterion(criteria: Criterion[], name: string): Criterion | undefined {
	const key = normalizeName(name);
	return criteria.find((c) => normalizeName(c.name) === key);
}

export function normalizeName(s: string): string {
	return s
		.toLowerCase()
		.replace(/\*+/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

// ---------------------------------------------------------------- internals

function addCriterion(criteria: Criterion[], name: string): Criterion {
	const c: Criterion = { name: name.replace(/\*+/g, "").trim(), maxPoints: 0, description: "", levels: [] };
	criteria.push(c);
	return c;
}

function levelText(level: string, desc: string): string {
	const l = level.replace(/\*+/g, "").trim();
	if (!l) return desc;
	if (!desc) return l;
	return new RegExp(`^${l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(desc) ? desc : `${l}: ${desc}`;
}

function cell(row: string[], i: number): string {
	return (row[i] ?? "").trim();
}

function esc(s: string): string {
	return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

/** "5", "5 pts", "/5", "0–5", "5.5" → the largest number present; undefined when none. */
export function parsePoints(s: string): number | undefined {
	const nums = s.replace(/\*+/g, "").match(/\d+(?:\.\d+)?/g);
	if (!nums || nums.length === 0) return undefined;
	return Math.max(...nums.map(Number));
}

function columnIndexes(header: string[]): { criterion: number; points: number; description: number; level: number } {
	const h = header.map((x) => x.toLowerCase().replace(/\*+/g, "").trim());
	const find = (names: string[]) => h.findIndex((x) => names.includes(x));
	let description = find(DESCRIPTION_HEADERS);
	if (description < 0) description = h.findIndex((x) => DESCRIPTION_HEADERS.some((n) => x.includes(n)));
	return { criterion: find(CRITERION_HEADERS), points: find(POINTS_HEADERS), description, level: find(LEVEL_HEADERS) };
}

function findTables(text: string): Table[] {
	const lines = text.split(/\r?\n/);
	const tables: Table[] = [];
	let heading = "";
	for (let i = 0; i < lines.length; i++) {
		const hm = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[i]);
		if (hm) {
			heading = hm[1];
			continue;
		}
		if (!isTableLine(lines[i])) continue;
		const block: string[] = [];
		while (i < lines.length && isTableLine(lines[i])) block.push(lines[i++]);
		i--;
		if (block.length < 2 || !/^\s*\|?\s*:?-{2,}/.test(block[1])) continue;
		const header = splitRow(block[0]);
		const rows = block.slice(2).map(splitRow);
		tables.push({ header, rows, heading });
	}
	return tables;
}

function isTableLine(line: string): boolean {
	return /^\s*\|.*\|?\s*$/.test(line) && line.includes("|");
}

function splitRow(line: string): string[] {
	let s = line.trim();
	if (s.startsWith("|")) s = s.slice(1);
	if (s.endsWith("|")) s = s.slice(0, -1);
	const cells: string[] = [];
	let cur = "";
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch === "\\" && s[i + 1] === "|") {
			cur += "|";
			i++;
		} else if (ch === "|") {
			cells.push(cur.trim());
			cur = "";
		} else cur += ch;
	}
	cells.push(cur.trim());
	return cells;
}

/** Removes a `## Heading` section (to the next heading of the same or higher level). */
export function stripSection(body: string, heading: string): string {
	const re = new RegExp(`^(#{1,6})\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "im");
	const m = re.exec(body);
	if (!m) return body;
	const level = m[1].length;
	const after = body.slice(m.index + m[0].length);
	const next = new RegExp(`^#{1,${level}}\\s+\\S`, "m").exec(after);
	return body.slice(0, m.index) + (next ? after.slice(next.index) : "");
}
