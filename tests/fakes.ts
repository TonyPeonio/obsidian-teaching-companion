import type { ChatMessage } from "../src/core/ollama";
import type { FileInfo, VaultAccess } from "../src/core/vault";

/** In-memory vault for tests: text files as strings, binaries as bytes. */
export class FakeVault implements VaultAccess {
	private files = new Map<string, string | Uint8Array>();
	private clock = 1_700_000_000_000;

	constructor(initial: Record<string, string | Uint8Array> = {}) {
		for (const [p, c] of Object.entries(initial)) this.files.set(p, c);
	}

	listFiles(): FileInfo[] {
		return Array.from(this.files.keys()).map((path) => {
			const name = path.split("/").pop() ?? path;
			const dot = name.lastIndexOf(".");
			return {
				path,
				basename: dot > 0 ? name.slice(0, dot) : name,
				extension: dot > 0 ? name.slice(dot + 1).toLowerCase() : "",
				folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
				mtime: (this.clock += 1000),
			};
		});
	}

	listFolders(): string[] {
		const out = new Set<string>();
		for (const path of this.files.keys()) {
			const parts = path.split("/");
			for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("/"));
		}
		return Array.from(out).sort();
	}

	exists(path: string): boolean {
		return this.files.has(path);
	}

	async read(path: string): Promise<string> {
		const c = this.files.get(path);
		if (c === undefined) throw new Error(`File not found: ${path}`);
		return typeof c === "string" ? c : new TextDecoder().decode(c);
	}

	async readBinary(path: string): Promise<Uint8Array> {
		const c = this.files.get(path);
		if (c === undefined) throw new Error(`File not found: ${path}`);
		return typeof c === "string" ? new TextEncoder().encode(c) : c;
	}

	async create(path: string, content: string): Promise<void> {
		if (this.files.has(path)) throw new Error(`Already exists: ${path}`);
		this.files.set(path, content);
	}

	async modify(path: string, content: string): Promise<void> {
		if (!this.files.has(path)) throw new Error(`File not found: ${path}`);
		this.files.set(path, content);
	}

	paths(): string[] {
		return Array.from(this.files.keys()).sort();
	}
}

/** A chat that replies from a queue and records every prompt it saw. */
export function fakeChat(replies: string[]): { chat: (messages: ChatMessage[]) => Promise<string>; prompts: ChatMessage[][] } {
	const prompts: ChatMessage[][] = [];
	const queue = [...replies];
	return {
		prompts,
		chat: async (messages) => {
			prompts.push(messages);
			const next = queue.shift();
			if (next === undefined) throw new Error("fakeChat: no reply left");
			return next;
		},
	};
}

export const ESSAY_RUBRIC = `---
total: 20
---
# Essay rubric

| Criterion | Points | Description |
|---|---|---|
| Thesis | 5 | States a clear, arguable thesis early. |
| | 5 | Excellent: specific, arguable, guides the essay. |
| | 3 | Adequate: present but broad. |
| | 1 | Weak: no identifiable thesis. |
| Evidence | 10 | Supports claims with cited evidence and explains the link. |
| Mechanics | 5 | Grammar and spelling do not get in the way. |
`;

export const STRONG_ESSAY = `Remote work raises productivity for knowledge workers because it removes commuting and lets people choose their most focused hours.

Bloom et al. (2015) found a 13% performance increase among call-centre staff who worked from home, and the effect persisted over nine months. This supports the claim because the staff did the same measurable tasks under both conditions.

A second study by Choudhury (2021) showed that patent examiners who could work from anywhere produced 4.4% more output. Together these findings show that flexibility, not merely location, drives the gain.

In short, the evidence points one way: well-supported remote work makes people more productive.
`;

export const WEAK_ESSAY = `Remote work is good. Many people like it and it is popular now.

Some people say it helps and some say it doesnt. I think its fine. Their are lots of opinions on this.

In conclusion remote work is a thing that exists and people have views about it.
`;
