import { Notice, Plugin, TFile, loadPdfJs, requestUrl } from "obsidian";
import { GRADE_BOOK_NAME, isGradeBook, renderGradeBook, type GradeRecord } from "./core/gradebook";
import { GradingParseError, gradeSubmission, type ChatFn, type GradingResult } from "./core/grading";
import { gradingFolderFor, gradingNotePath, parseGradingNote, renderGradingNote, yourScoresOf } from "./core/notes";
import { OllamaClient, explainOllamaError } from "./core/ollama";
import { extractPdfPages, type PdfJsLike } from "./core/pdf";
import { parseRubric, precheckRubric, rubricTemplate, type Rubric } from "./core/rubric";
import { parseSuggestions, rubricCheckMessages, writeSuggestions } from "./core/rubric-check";
import { isSubmissionFile, loadSubmission, pastedSubmission, SubmissionError, type PdfExtractor } from "./core/submission";
import type { Submission } from "./core/text";
import { filesInFolder, joinPath, notesUnder, safeFileName, writeNote, type FileInfo } from "./core/vault";
import { FolderGradeModal, GradeModal, NameModal, ProgressModal, RubricPickModal, type RubricChoice } from "./modals";
import { ObsidianVault } from "./obsidian-vault";
import { DEFAULT_SETTINGS, type TeachingCompanionSettings } from "./settings";
import { TeachingCompanionSettingTab } from "./settings-tab";

export default class TeachingCompanionPlugin extends Plugin {
	settings: TeachingCompanionSettings = { ...DEFAULT_SETTINGS };
	client!: OllamaClient;
	vault!: ObsidianVault;
	private busy = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.vault = new ObsidianVault(this.app);
		this.client = new OllamaClient(
			() => this.settings.ollamaUrl,
			(...args) => fetch(...args),
			async (url, body, method) => {
				const res = await requestUrl(method === "GET" ? { url, method, throw: false } : { url, method, contentType: "application/json", body, throw: false });
				return { status: res.status, text: res.text };
			},
		);
		this.addSettingTab(new TeachingCompanionSettingTab(this.app, this));

		this.addRibbonIcon("clipboard-check", "Grade a submission", () => void this.gradeOneCommand());
		this.addCommand({ id: "new-rubric", name: "New rubric", callback: () => void this.newRubric() });
		this.addCommand({ id: "grade-submission", name: "Grade a submission", callback: () => void this.gradeOneCommand() });
		this.addCommand({ id: "grade-folder", name: "Grade a folder", callback: () => void this.gradeFolderCommand() });
		this.addCommand({ id: "grade-book", name: "Grade book", callback: () => void this.gradeBookCommand() });
		this.addCommand({ id: "rubric-check", name: "Rubric check", callback: () => void this.rubricCheckCommand() });
	}

	async loadSettings(): Promise<void> {
		this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<TeachingCompanionSettings> | null) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	// ---------------------------------------------------------------- rubrics

	private rubricChoices(): RubricChoice[] {
		return notesUnder(this.vault, this.settings.rubricsFolder)
			.filter((f) => f.basename !== GRADE_BOOK_NAME)
			.map((f) => ({ path: f.path, name: f.basename }));
	}

	private async loadRubric(path: string): Promise<{ rubric: Rubric; file: FileInfo }> {
		const file = this.vault.listFiles().find((f) => f.path === path);
		if (!file) throw new Error(`Rubric not found: ${path}`);
		const rubric = parseRubric(await this.vault.read(path), file.basename);
		if (rubric.criteria.length === 0) throw new Error(`"${file.basename}" has no criteria table. See New rubric for the format.`);
		return { rubric, file };
	}

	async newRubric(): Promise<void> {
		const modal = new NameModal(this.app, "New rubric", `Writes a rubric template to ${this.settings.rubricsFolder}/. Edit the criteria, points and level descriptions, then grade with it.`, "Essay 1 rubric");
		modal.open();
		const name = await modal.result;
		if (!name) return;
		const path = joinPath(this.settings.rubricsFolder, `${safeFileName(name)}.md`);
		if (this.vault.exists(path)) {
			new Notice(`"${path}" already exists.`);
			await this.app.workspace.openLinkText(path, "", false);
			return;
		}
		await this.vault.create(path, rubricTemplate(name));
		await this.app.workspace.openLinkText(path, "", false);
		new Notice("Rubric template created. Replace the example criteria with yours.");
	}

	// ---------------------------------------------------------------- grading

	private chatFn(signal?: AbortSignal): ChatFn {
		return (messages, sig) =>
			this.client.chat({
				model: this.settings.model,
				messages,
				options: { num_ctx: this.settings.numCtx, temperature: 0.1 },
				think: false,
				format: "json",
				keep_alive: "10m",
				signal: sig ?? signal,
			});
	}

	private pdfExtractor(): PdfExtractor {
		return async (bytes) => extractPdfPages(bytes, (await loadPdfJs()) as PdfJsLike);
	}

	private submissionFiles(): string[] {
		return this.vault
			.listFiles()
			.filter(isSubmissionFile)
			.filter((f) => !f.path.startsWith(this.settings.gradingFolder + "/") && !f.path.startsWith(this.settings.rubricsFolder + "/"))
			.map((f) => f.path)
			.sort((a, b) => a.localeCompare(b));
	}

	/** Grades one submission and writes its note; returns the note path. */
	private async gradeAndWrite(rubric: Rubric, submission: Submission, signal: AbortSignal | undefined, onProgress?: (done: number, total: number) => void): Promise<{ path: string; result: GradingResult }> {
		const path = gradingNotePath(this.settings.gradingFolder, rubric.name, submission.name);
		const previous = this.vault.exists(path) ? yourScoresOf(parseGradingNote(await this.vault.read(path))) : new Map<string, number>();
		const result = await gradeSubmission(rubric, submission, this.chatFn(signal), { numCtx: this.settings.numCtx, signal, onProgress });
		const content = renderGradingNote({
			rubric,
			submission,
			result,
			model: this.settings.model,
			date: today(),
			comments: { tone: this.settings.commentsTone, includeQuotes: this.settings.includeQuotesInComments },
			previousScores: previous.size ? previous : undefined,
		});
		await writeNote(this.vault, path, content);
		return { path, result };
	}

	private async loadFromSource(source: { kind: "file"; path: string } | { kind: "paste"; name: string; text: string }): Promise<Submission> {
		if (source.kind === "paste") return pastedSubmission(source.name, source.text);
		const file = this.vault.listFiles().find((f) => f.path === source.path);
		if (!file) throw new SubmissionError(`No file at ${source.path}.`);
		return loadSubmission(this.vault, file, this.pdfExtractor());
	}

	async gradeOneCommand(): Promise<void> {
		if (this.busy) return void new Notice("A grading run is already in progress.");
		const rubrics = this.rubricChoices();
		if (rubrics.length === 0) return void new Notice(`No rubric notes in ${this.settings.rubricsFolder}. Run New rubric first.`, 8000);
		const active = this.app.workspace.getActiveFile();
		const files = this.submissionFiles();
		const modal = new GradeModal(this.app, rubrics, files, { rubricPath: this.settings.lastRubric, filePath: active && files.includes(active.path) ? active.path : "" });
		modal.open();
		const req = await modal.result;
		if (!req) return;
		this.settings.lastRubric = req.rubricPath;
		await this.saveSettings();
		this.busy = true;
		const notice = new Notice("Reading the submission…", 0);
		try {
			const { rubric } = await this.loadRubric(req.rubricPath);
			const submission = await this.loadFromSource(req.source);
			notice.setMessage(`Grading "${submission.name}" with ${this.settings.model}…`);
			const { path, result } = await this.gradeAndWrite(rubric, submission, undefined, (done, total) => {
				if (total > 1) notice.setMessage(`Grading "${submission.name}": call ${Math.min(done + 1, total)} of ${total}…`);
			});
			notice.hide();
			await this.app.workspace.openLinkText(path, "", false);
			new Notice(`Proposed ${result.totalProposed}/${result.totalMax} for "${submission.name}"${result.droppedQuotes ? ` (${result.droppedQuotes} ungrounded quotes dropped)` : ""}${result.missingCriteria.length ? `; not scored: ${result.missingCriteria.join(", ")}` : ""}. Fill in "Your score" to finish.`, 10000);
		} catch (err) {
			notice.hide();
			new Notice(this.describe(err), 12000);
		} finally {
			this.busy = false;
		}
	}

	async gradeFolderCommand(): Promise<void> {
		if (this.busy) return void new Notice("A grading run is already in progress.");
		const rubrics = this.rubricChoices();
		if (rubrics.length === 0) return void new Notice(`No rubric notes in ${this.settings.rubricsFolder}. Run New rubric first.`, 8000);
		const folders = this.vault.listFolders().filter((f) => f !== this.settings.gradingFolder && !f.startsWith(this.settings.gradingFolder + "/") && f !== this.settings.rubricsFolder);
		const active = this.app.workspace.getActiveFile();
		const initialFolder = this.settings.lastSubmissionsFolder || (active?.parent && active.parent.path !== "/" ? active.parent.path : "");
		const modal = new FolderGradeModal(this.app, rubrics, folders, { rubricPath: this.settings.lastRubric, folder: initialFolder });
		modal.open();
		const req = await modal.result;
		if (!req) return;
		this.settings.lastRubric = req.rubricPath;
		this.settings.lastSubmissionsFolder = req.folder;
		await this.saveSettings();

		let rubric: Rubric;
		try {
			rubric = (await this.loadRubric(req.rubricPath)).rubric;
		} catch (err) {
			return void new Notice(this.describe(err), 10000);
		}
		const files = filesInFolder(this.vault, req.folder).filter(isSubmissionFile);
		if (files.length === 0) return void new Notice(`No .md, .txt or .pdf files directly in ${req.folder}.`, 8000);
		const todo = req.regrade ? files : files.filter((f) => !this.vault.exists(gradingNotePath(this.settings.gradingFolder, rubric.name, f.basename)));
		const skipped = files.length - todo.length;
		if (todo.length === 0) return void new Notice(`All ${files.length} submissions already have a grading note. Choose re-grade to redo them.`, 8000);

		this.busy = true;
		const progress = new ProgressModal(this.app, `Grading ${todo.length} submission${todo.length === 1 ? "" : "s"} with ${rubric.name}`);
		progress.open();
		if (skipped) progress.log(`Skipped ${skipped} with an existing grading note.`);
		let done = 0;
		let failed = 0;
		const extractor = this.pdfExtractor();
		try {
			for (const file of todo) {
				if (progress.signal.aborted) break;
				progress.setText(`${done + 1} of ${todo.length}: ${file.basename}…`);
				try {
					const submission = await loadSubmission(this.vault, file, extractor);
					const { result } = await this.gradeAndWrite(rubric, submission, progress.signal);
					done++;
					progress.log(`${file.basename}: ${result.totalProposed}/${result.totalMax}${result.droppedQuotes ? `, ${result.droppedQuotes} quotes dropped` : ""}${result.missingCriteria.length ? `, not scored: ${result.missingCriteria.join(", ")}` : ""}`);
				} catch (err) {
					if (progress.signal.aborted) break;
					failed++;
					progress.log(`${file.basename}: ${this.describe(err)}`);
				}
			}
		} finally {
			this.busy = false;
		}
		const cancelled = progress.signal.aborted;
		progress.finish(`${cancelled ? "Cancelled. " : ""}${done} graded${failed ? `, ${failed} failed` : ""}${skipped ? `, ${skipped} skipped` : ""}. Notes are in ${gradingFolderFor(this.settings.gradingFolder, rubric.name)}/.`);
		if (done > 0) await this.writeGradeBook(rubric);
	}

	// ---------------------------------------------------------------- grade book

	private async pickRubric(heading: string, help: string, label: string): Promise<Rubric | null> {
		const rubrics = this.rubricChoices();
		if (rubrics.length === 0) {
			new Notice(`No rubric notes in ${this.settings.rubricsFolder}. Run New rubric first.`, 8000);
			return null;
		}
		// A grading note or a rubric note that is open picks its rubric.
		const active = this.app.workspace.getActiveFile();
		let initial = this.settings.lastRubric;
		if (active instanceof TFile && active.extension === "md") {
			const byName = rubrics.find((r) => r.path === active.path);
			if (byName) initial = byName.path;
			else if (active.path.startsWith(this.settings.gradingFolder + "/")) {
				const rubricFolder = active.parent?.name ?? "";
				const match = rubrics.find((r) => safeFileName(r.name) === rubricFolder);
				if (match) initial = match.path;
			}
		}
		const modal = new RubricPickModal(this.app, heading, help, rubrics, initial, label);
		modal.open();
		const path = await modal.result;
		if (!path) return null;
		this.settings.lastRubric = path;
		await this.saveSettings();
		try {
			return (await this.loadRubric(path)).rubric;
		} catch (err) {
			new Notice(this.describe(err), 10000);
			return null;
		}
	}

	async gradeBookCommand(): Promise<void> {
		const rubric = await this.pickRubric("Grade book", `Rebuilds ${this.settings.gradingFolder}/<rubric>/${GRADE_BOOK_NAME}.md from the grading notes in that folder. Only that note is written.`, "Build grade book");
		if (!rubric) return;
		const path = await this.writeGradeBook(rubric);
		await this.app.workspace.openLinkText(path, "", false);
	}

	private async writeGradeBook(rubric: Rubric): Promise<string> {
		const folder = gradingFolderFor(this.settings.gradingFolder, rubric.name);
		const records: GradeRecord[] = [];
		for (const f of filesInFolder(this.vault, folder, ["md"])) {
			const content = await this.vault.read(f.path);
			if (isGradeBook(content, f.basename)) continue;
			const summary = parseGradingNote(content);
			if (summary) records.push({ path: f.path, basename: f.basename, summary });
		}
		const path = joinPath(folder, `${GRADE_BOOK_NAME}.md`);
		await writeNote(this.vault, path, renderGradeBook(rubric.name, rubric, records, today()));
		new Notice(`Grade book: ${records.length} submission${records.length === 1 ? "" : "s"}, ${records.filter((r) => r.summary.complete).length} final.`);
		return path;
	}

	// ---------------------------------------------------------------- rubric check

	async rubricCheckCommand(): Promise<void> {
		const rubrics = this.rubricChoices();
		const active = this.app.workspace.getActiveFile();
		let path: string | null = active && rubrics.some((r) => r.path === active.path) ? active.path : null;
		if (!path) {
			const picked = await this.pickRubric("Rubric check", "Flags criteria without a description or points that do not add up, then asks the local model whether criteria overlap or cannot be observed. Suggestions are written under ## Suggestions in the rubric note.", "Check rubric");
			if (!picked) return;
			path = rubrics.find((r) => r.name === picked.name)?.path ?? null;
			if (!path) return;
		}
		const file = this.vault.listFiles().find((f) => f.path === path);
		if (!file) return;
		const content = await this.vault.read(path);
		const rubric = parseRubric(content, file.basename);
		const issues = precheckRubric(rubric);
		let suggestions: string[] | null = null;
		let modelUsed: string | null = null;
		if (rubric.criteria.length > 0) {
			const notice = new Notice(`Checking "${rubric.name}" with ${this.settings.model}…`, 0);
			try {
				const reply = await this.client.chat({ model: this.settings.model, messages: rubricCheckMessages(rubric), options: { num_ctx: Math.min(this.settings.numCtx, 8192), temperature: 0.2 }, think: false, format: "json", keep_alive: "10m" });
				suggestions = parseSuggestions(reply);
				modelUsed = this.settings.model;
			} catch (err) {
				new Notice(`${explainOllamaError(err, this.settings.model, this.settings.ollamaUrl)} The deterministic checks were still written.`, 10000);
			} finally {
				notice.hide();
			}
		}
		const current = await this.vault.read(path);
		await this.vault.modify(path, writeSuggestions(current, issues, suggestions, modelUsed, today()));
		await this.app.workspace.openLinkText(path, "", false);
		new Notice(`${issues.length} check${issues.length === 1 ? "" : "s"} flagged${suggestions ? `, ${suggestions.length} model suggestion${suggestions.length === 1 ? "" : "s"}` : ""}. See ## Suggestions.`, 8000);
	}

	// ---------------------------------------------------------------- helpers

	private describe(err: unknown): string {
		if (err instanceof SubmissionError || err instanceof GradingParseError) return err.message;
		if (err instanceof Error && err.name === "AbortError") return "Cancelled.";
		return explainOllamaError(err, this.settings.model, this.settings.ollamaUrl);
	}
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}
