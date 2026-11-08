/**
 * Everything the core needs from the vault, so rubric parsing, grading and the grade book
 * run without Obsidian (the plugin layer implements it over `app.vault`; tests use an
 * in-memory fake). Submissions may be PDFs, so files of any extension are listed and
 * binary reads are part of the contract.
 */

export interface FileInfo {
	/** Vault-relative path including the extension. */
	path: string;
	/** File name without the extension. */
	basename: string;
	/** Lower-case extension without the dot ("md", "pdf", "txt"). */
	extension: string;
	/** Parent folder, "" for the vault root. */
	folder: string;
	mtime: number;
}

export interface VaultAccess {
	/** Every file in the vault (not only notes), excluding the config directory. */
	listFiles(): FileInfo[];
	/** Every folder path in the vault ("" for the root is not included). */
	listFolders(): string[];
	exists(path: string): boolean;
	read(path: string): Promise<string>;
	readBinary(path: string): Promise<Uint8Array>;
	create(path: string, content: string): Promise<void>;
	modify(path: string, content: string): Promise<void>;
}

/** Files directly inside `folder` (not recursive), sorted by path; the vault root when "". */
export function filesInFolder(vault: VaultAccess, folder: string, extensions?: string[]): FileInfo[] {
	const prefix = trimSlashes(folder);
	return vault
		.listFiles()
		.filter((f) => f.folder === prefix)
		.filter((f) => !extensions || extensions.includes(f.extension))
		.sort((a, b) => a.path.localeCompare(b.path));
}

/** Notes (`.md`) anywhere under `folder`, recursive. */
export function notesUnder(vault: VaultAccess, folder: string): FileInfo[] {
	const prefix = trimSlashes(folder);
	return vault
		.listFiles()
		.filter((f) => f.extension === "md" && (prefix ? f.path.startsWith(prefix + "/") : true))
		.sort((a, b) => a.path.localeCompare(b.path));
}

/** Creates or overwrites. */
export async function writeNote(vault: VaultAccess, path: string, content: string): Promise<void> {
	if (vault.exists(path)) await vault.modify(path, content);
	else await vault.create(path, content);
}

export function trimSlashes(p: string): string {
	return p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

export function joinPath(...parts: string[]): string {
	return parts
		.map(trimSlashes)
		.filter((p) => p.length > 0)
		.join("/");
}

/** Removes characters that are not allowed in Obsidian file names. */
export function safeFileName(name: string): string {
	return name
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim() || "Untitled";
}

export const SUBMISSION_EXTENSIONS = ["md", "txt", "pdf"];
