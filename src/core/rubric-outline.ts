/**
 * Outline rubrics: the shape people paste from a syllabus or an LMS, with no table at all.
 *
 *   * Introduction (20 points)
 *      * The problem you solve, and why you chose it
 *      * Background a reader needs to understand the problem
 *   ## Technical details (40 points)          headings with points work the same way
 *   - The dataset, with an example row
 *   - 40 — Excellent: every choice is justified   a nested item that starts with a number is a level
 *   There will be 10 points for overall quality (writing, grammar, spelling).
 *
 * A top-level list item or a heading that carries points becomes a criterion. Everything nested
 * under it (deeper list items, or the lines under the heading up to the next heading) becomes its
 * description; a nested item that starts with a number ("5 — Excellent: …", "3 pts: adequate")
 * is a score level. A sentence of the form "N points for X" becomes a criterion named X. Points
 * are read from "(20 points)", "(20 pts)", "[20]", "(20)" or a trailing "- 20 points" / ": 20 pts".
 *
 * `parseRubric` uses this only when the note has no criteria table.
 */

import type { Criterion } from "./rubric";

const POINTS_WORD = "(?:points?|pts?|marks?)";
const PAREN_POINTS = new RegExp(`[(\\[]\\s*(\\d+(?:\\.\\d+)?)\\s*${POINTS_WORD}?\\s*[)\\]]`, "i");
const TRAILING_POINTS = new RegExp(`(?:[-–—:]|\\s)\\s*(\\d+(?:\\.\\d+)?)\\s*${POINTS_WORD}\\s*:?\\s*$`, "i");
const SENTENCE_POINTS = new RegExp(`\\b(\\d+(?:\\.\\d+)?)\\s*${POINTS_WORD}\\s+(?:for|on|to|towards?)\\s+(?:the\\s+|your\\s+|an?\\s+)?([^.;:(]+)`, "i");
const LEVEL_LINE = new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*${POINTS_WORD}?\\s*(?:[:—–-]|\\.\\s|\\)\\s)\\s*(.+)$`, "i");

interface Item {
	kind: "heading" | "bullet" | "prose";
	/** Leading whitespace width for bullets (tabs count four); 0 otherwise. */
	indent: number;
	text: string;
}

interface ParsedLine {
	name: string;
	points?: number;
	description: string;
}

export function parseOutlineRubric(text: string): Criterion[] {
	const items = collectItems(text);
	const bulletIndents = items.filter((i) => i.kind === "bullet").map((i) => i.indent);
	const top = bulletIndents.length ? Math.min(...bulletIndents) : 0;
	const anyTopHasPoints = items.some((i) => i.kind === "bullet" && i.indent <= top && criterionLine(i.text).points !== undefined);

	const criteria: Criterion[] = [];
	const parts = new Map<Criterion, string[]>();
	let current: Criterion | null = null;
	let fromHeading = false;

	const add = (p: ParsedLine): Criterion => {
		const c: Criterion = { name: p.name, maxPoints: p.points ?? 0, description: "", levels: [] };
		criteria.push(c);
		parts.set(c, p.description ? [p.description] : []);
		return c;
	};
	const describe = (c: Criterion, s: string): void => {
		const t = s.replace(/\*\*|__/g, "").trim();
		if (t) parts.get(c)?.push(t);
	};

	for (const it of items) {
		if (it.kind === "heading") {
			const p = criterionLine(it.text);
			if (p.points !== undefined) {
				current = add(p);
				fromHeading = true;
			} else {
				current = null;
				fromHeading = false;
			}
			continue;
		}
		if (it.kind === "bullet" && it.indent <= top) {
			// Under a heading that carries points, the list is the description (or the levels).
			if (current && fromHeading) {
				const lv = LEVEL_LINE.exec(it.text.replace(/\*\*|__/g, "").trim());
				if (lv) current.levels.push({ points: Number(lv[1]), description: lv[2].trim() });
				else describe(current, it.text);
				continue;
			}
			const p = criterionLine(it.text);
			if (p.points !== undefined) {
				current = add(p);
				fromHeading = false;
			} else if (!anyTopHasPoints) {
				current = add(p);
				fromHeading = false;
			} else if (current) {
				describe(current, it.text);
			}
			continue;
		}
		if (it.kind === "bullet") {
			if (!current) continue;
			const lv = LEVEL_LINE.exec(it.text.replace(/\*\*|__/g, "").trim());
			if (lv) current.levels.push({ points: Number(lv[1]), description: lv[2].trim() });
			else describe(current, it.text);
			continue;
		}
		const s = SENTENCE_POINTS.exec(it.text);
		if (s) {
			const name = s[2].trim().replace(/\s+/g, " ");
			current = add({ name: name.charAt(0).toUpperCase() + name.slice(1), points: Number(s[1]), description: it.text.trim() });
			fromHeading = false;
			continue;
		}
		if (current && fromHeading) describe(current, it.text);
	}

	for (const c of criteria) c.description = joinParts(parts.get(c) ?? []);
	return criteria;
}

/** "Introduction (20 points)" → name and points; "Thesis (5 pts): clear and arguable" also yields a description. */
export function criterionLine(text: string): ParsedLine {
	let s = text.replace(/\*\*|__/g, "").trim();
	let points: number | undefined;
	let m = PAREN_POINTS.exec(s);
	if (m) {
		points = Number(m[1]);
		s = (s.slice(0, m.index) + " " + s.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
	} else if ((m = TRAILING_POINTS.exec(s))) {
		points = Number(m[1]);
		s = s.slice(0, m.index).trim();
	}
	const split = /^(.{1,80}?)\s*(?::|—|–| - )\s*(.+)$/.exec(s);
	const name = (split ? split[1] : s).replace(/[\s:\-–—]+$/, "").trim();
	return { name, points, description: split ? split[2].trim() : "" };
}

function collectItems(text: string): Item[] {
	const items: Item[] = [];
	let inFence = false;
	for (const raw of text.split(/\r?\n/)) {
		if (/^\s*(```|~~~)/.test(raw)) {
			inFence = !inFence;
			continue;
		}
		if (inFence || !raw.trim()) continue;
		const h = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(raw);
		if (h) {
			items.push({ kind: "heading", indent: 0, text: h[1] });
			continue;
		}
		const b = /^(\s*)(?:[-*+•]|\d+[.)])\s+(.*)$/.exec(raw);
		if (b) {
			items.push({ kind: "bullet", indent: b[1].replace(/\t/g, "    ").length, text: b[2].trim() });
			continue;
		}
		items.push({ kind: "prose", indent: 0, text: raw.trim() });
	}
	return items;
}

/** Joins description fragments into one paragraph, closing each with a full stop when it has none. */
function joinParts(parts: string[]): string {
	return parts
		.map((p) => p.trim())
		.filter(Boolean)
		.map((p) => (/[.!?:;]$/.test(p) ? p : `${p}.`))
		.join(" ");
}
