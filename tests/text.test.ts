import { describe, expect, it } from "vitest";
import { estimateTokens, locateQuote, makeSubmission, normalizeForMatch, splitParagraphs, truncateToTokens } from "../src/core/text";

describe("text helpers", () => {
	it("normalises case, whitespace, curly quotes and dashes", () => {
		expect(normalizeForMatch("  The\tStudent’s  “Thesis” — here… ")).toBe("the student's \"thesis\" - here...");
	});

	it("splits paragraphs on blank lines and collapses inner whitespace", () => {
		expect(splitParagraphs("a\nb\n\n\n  c   d \n\n")).toEqual(["a b", "c d"]);
	});

	it("estimates tokens from characters and truncates at a line break near the limit", () => {
		expect(estimateTokens("x".repeat(320))).toBe(100);
		// 14 tokens = 44 characters; the line break at 40 is within the last 20%, so the cut lands there.
		expect(truncateToTokens("a".repeat(40) + "\n" + "b".repeat(10), 14)).toBe("a".repeat(40));
		// A line break too early is ignored and the text is cut at the limit.
		expect(truncateToTokens("ab\n" + "c".repeat(60), 10)).toBe("ab\n" + "c".repeat(29));
		expect(truncateToTokens("short", 100)).toBe("short");
	});

	it("locates quotes that span a page break without a page number", () => {
		const sub = makeSubmission("p", "", "x", ["ends with alpha", "beta starts the next page"]);
		expect(locateQuote(sub, "alpha beta")).toEqual({ found: true, location: "pages" });
		expect(locateQuote(sub, "ab")).toEqual({ found: false });
	});
});
