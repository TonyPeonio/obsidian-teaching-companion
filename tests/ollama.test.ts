import { describe, expect, it } from "vitest";
import { OllamaClient, explainOllamaError, isConnectionError, stripThinkTags } from "../src/core/ollama";

function ndjsonResponse(lines: object[]): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const l of lines) controller.enqueue(new TextEncoder().encode(JSON.stringify(l) + "\n"));
			controller.close();
		},
	});
	return new Response(body, { status: 200 });
}

describe("OllamaClient", () => {
	it("streams a chat reply, passes format/think/temperature, and strips think tags", async () => {
		const seen: { url: string; init: RequestInit }[] = [];
		const client = new OllamaClient(
			() => "http://localhost:11434/",
			async (url, init) => {
				seen.push({ url: String(url), init: init ?? {} });
				return ndjsonResponse([{ message: { content: "<think>hmm</think>{\"a\":" } }, { message: { content: "1}" } }, { done: true }]);
			},
		);
		const text = await client.chat({ model: "m", messages: [{ role: "user", content: "hi" }], options: { temperature: 0.1, num_ctx: 4096 }, think: false, format: "json" });
		expect(text).toBe('{"a":1}');
		expect(seen[0].url).toBe("http://localhost:11434/api/chat");
		const body = JSON.parse(seen[0].init.body as string) as Record<string, unknown>;
		expect(body).toMatchObject({ model: "m", stream: true, think: false, format: "json", options: { temperature: 0.1, num_ctx: 4096 } });
	});

	it("uses GET for /api/tags and /api/version", async () => {
		const methods: string[] = [];
		const client = new OllamaClient(
			() => "http://x",
			async (url, init) => {
				methods.push(`${init?.method ?? "GET"} ${String(url)}`);
				return new Response(JSON.stringify(String(url).endsWith("version") ? { version: "0.9" } : { models: [{ name: "qwen3.5:9b", size: 1 }] }), { status: 200 });
			},
		);
		expect(await client.version()).toBe("0.9");
		expect((await client.listModels()).map((m) => m.name)).toEqual(["qwen3.5:9b"]);
		expect(methods).toEqual(["GET http://x/api/version", "GET http://x/api/tags"]);
	});

	it("falls back to the injected non-streaming POST when fetch fails", async () => {
		const client = new OllamaClient(
			() => "http://x",
			async () => {
				throw new TypeError("Failed to fetch");
			},
			async (url, body, method) => {
				expect(method).toBe("POST");
				expect(url).toBe("http://x/api/chat");
				expect((JSON.parse(body ?? "{}") as Record<string, unknown>).stream).toBe(false);
				return { status: 200, text: JSON.stringify({ message: { content: "fallback" } }) };
			},
		);
		expect(await client.chat({ model: "m", messages: [] })).toBe("fallback");
	});

	it("explains common errors and recognises connection failures", () => {
		expect(explainOllamaError(new Error("model 'x' not found, try pulling it"), "x", "http://h")).toMatch(/ollama pull x/);
		expect(explainOllamaError(new Error("Cannot reach Ollama at http://h"), "x", "http://h")).toMatch(/Start Ollama/);
		expect(isConnectionError(new Error("fetch failed"))).toBe(true);
		expect(isConnectionError(new Error("bad json"))).toBe(false);
		expect(stripThinkTags("<think>a</think> b")).toBe("b");
	});
});
