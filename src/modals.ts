import { App, Modal, Setting } from "obsidian";

export interface RubricChoice {
	/** Vault path of the rubric note. */
	path: string;
	/** Note basename, shown in the dropdown. */
	name: string;
}

/** A modal that resolves a promise once, with Cancel and a validated primary button. */
abstract class PromiseModal<T> extends Modal {
	private resolve!: (r: T | null) => void;
	readonly result: Promise<T | null>;
	private done = false;
	protected errorEl: HTMLElement | null = null;

	constructor(app: App) {
		super(app);
		this.result = new Promise((res) => (this.resolve = res));
	}

	protected finish(r: T | null): void {
		if (this.done) return;
		this.done = true;
		this.resolve(r);
		this.close();
	}

	protected showError(message: string): void {
		this.errorEl?.setText(message);
	}

	onClose(): void {
		this.contentEl.empty();
		this.finish(null);
	}

	protected rubricSetting(container: HTMLElement, rubrics: RubricChoice[], initial: string, onChange: (path: string) => void): void {
		new Setting(container)
			.setName("Rubric")
			.setDesc(rubrics.length ? "A note in the rubrics folder." : "No rubric notes found. Run New rubric first.")
			.addDropdown((d) => {
				for (const r of rubrics) d.addOption(r.path, r.name);
				const start = rubrics.find((r) => r.path === initial)?.path ?? rubrics[0]?.path ?? "";
				d.setValue(start);
				onChange(start);
				d.onChange(onChange);
			});
	}

	protected datalist(container: HTMLElement, id: string, values: string[]): string {
		const list = container.createEl("datalist", { attr: { id } });
		for (const v of values) list.createEl("option", { value: v });
		return id;
	}

	protected buttons(container: HTMLElement, label: string, onConfirm: () => void): void {
		this.errorEl = container.createEl("p", { cls: "tc-modal-error" });
		new Setting(container).addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(null))).addButton((b) => b.setButtonText(label).setCta().onClick(onConfirm));
	}
}

// ---------------------------------------------------------------- new rubric

export class NameModal extends PromiseModal<string> {
	private value = "";

	constructor(
		app: App,
		private heading: string,
		private help: string,
		private placeholder: string,
		private label = "Create",
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, titleEl, modalEl } = this;
		modalEl.addClass("tc-modal");
		titleEl.setText(this.heading);
		contentEl.createEl("p", { cls: "tc-modal-help", text: this.help });
		new Setting(contentEl).setName("Name").addText((t) => {
			t.setPlaceholder(this.placeholder).onChange((v) => (this.value = v));
			t.inputEl.addClass("tc-modal-wide");
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && this.value.trim()) {
					e.preventDefault();
					this.finish(this.value.trim());
				}
			});
			window.setTimeout(() => t.inputEl.focus(), 0);
		});
		this.buttons(contentEl, this.label, () => {
			if (!this.value.trim()) return this.showError("Enter a name.");
			this.finish(this.value.trim());
		});
	}
}

// ---------------------------------------------------------------- grade a submission

export type SubmissionSource = { kind: "file"; path: string } | { kind: "paste"; name: string; text: string };

export interface GradeRequest {
	rubricPath: string;
	source: SubmissionSource;
}

export class GradeModal extends PromiseModal<GradeRequest> {
	private rubricPath = "";
	private mode: "file" | "paste" = "file";
	private filePath = "";
	private pasteName = "";
	private pasteText = "";

	constructor(
		app: App,
		private rubrics: RubricChoice[],
		private files: string[],
		private initial: { rubricPath: string; filePath: string },
	) {
		super(app);
		this.filePath = initial.filePath;
	}

	onOpen(): void {
		const { contentEl, titleEl, modalEl } = this;
		modalEl.addClass("tc-modal");
		titleEl.setText("Grade a submission");
		contentEl.createEl("p", {
			cls: "tc-modal-help",
			text: "The submission's text is sent to your local Ollama model with the rubric; the model proposes a score, a justification and verbatim quotes per criterion. The result is a draft note you finish by filling in \"Your score\".",
		});
		this.rubricSetting(contentEl, this.rubrics, this.initial.rubricPath, (p) => (this.rubricPath = p));

		const fileSetting = new Setting(contentEl);
		const pasteSettings: Setting[] = [];
		const applyMode = () => {
			fileSetting.settingEl.toggle(this.mode === "file");
			for (const s of pasteSettings) s.settingEl.toggle(this.mode === "paste");
		};

		new Setting(contentEl)
			.setName("Submission")
			.setDesc("A note, .txt or .pdf file in the vault, or text you paste.")
			.addDropdown((d) => {
				d.addOption("file", "File in the vault");
				d.addOption("paste", "Pasted text");
				d.setValue(this.mode);
				d.onChange((v) => {
					this.mode = v === "paste" ? "paste" : "file";
					applyMode();
				});
			});

		const listId = this.datalist(contentEl, "tc-submission-files", this.files);
		fileSetting
			.setName("File")
			.setDesc("Vault path. Start typing to pick from .md, .txt and .pdf files.")
			.addText((t) => {
				t.setPlaceholder("Submissions/alice.pdf").setValue(this.filePath).onChange((v) => (this.filePath = v.trim()));
				t.inputEl.setAttribute("list", listId);
				t.inputEl.addClass("tc-modal-wide");
			});

		pasteSettings.push(
			new Setting(contentEl).setName("Student or submission name").setDesc("Becomes the grading note's file name.").addText((t) => {
				t.setPlaceholder("alice").onChange((v) => (this.pasteName = v));
				t.inputEl.addClass("tc-modal-wide");
			}),
		);
		pasteSettings.push(
			new Setting(contentEl).setName("Text").addTextArea((t) => {
				t.setPlaceholder("Paste the submission here…").onChange((v) => (this.pasteText = v));
				t.inputEl.addClass("tc-paste");
			}),
		);
		applyMode();

		this.buttons(contentEl, "Grade", () => {
			if (!this.rubricPath) return this.showError("Pick a rubric (create one with New rubric).");
			if (this.mode === "file") {
				if (!this.filePath) return this.showError("Enter the submission's vault path.");
				if (!this.files.includes(this.filePath)) return this.showError(`No .md, .txt or .pdf file at "${this.filePath}".`);
				this.finish({ rubricPath: this.rubricPath, source: { kind: "file", path: this.filePath } });
			} else {
				if (!this.pasteText.trim()) return this.showError("Paste the submission text.");
				if (!this.pasteName.trim()) return this.showError("Give the submission a name.");
				this.finish({ rubricPath: this.rubricPath, source: { kind: "paste", name: this.pasteName.trim(), text: this.pasteText } });
			}
		});
	}
}

// ---------------------------------------------------------------- grade a folder

export interface FolderGradeRequest {
	rubricPath: string;
	folder: string;
	regrade: boolean;
}

export class FolderGradeModal extends PromiseModal<FolderGradeRequest> {
	private rubricPath = "";
	private folder: string;
	private regrade = false;

	constructor(
		app: App,
		private rubrics: RubricChoice[],
		private folders: string[],
		private initial: { rubricPath: string; folder: string },
	) {
		super(app);
		this.folder = initial.folder;
	}

	onOpen(): void {
		const { contentEl, titleEl, modalEl } = this;
		modalEl.addClass("tc-modal");
		titleEl.setText("Grade a folder");
		contentEl.createEl("p", { cls: "tc-modal-help", text: "Every .md, .txt and .pdf file directly in the folder gets its own grading note. Files that already have one are skipped unless you choose to re-grade; \"Your score\" values you typed are carried over." });
		this.rubricSetting(contentEl, this.rubrics, this.initial.rubricPath, (p) => (this.rubricPath = p));
		const listId = this.datalist(contentEl, "tc-folders", this.folders);
		new Setting(contentEl)
			.setName("Submissions folder")
			.addText((t) => {
				t.setPlaceholder("Submissions/Essay 1").setValue(this.folder).onChange((v) => (this.folder = v.trim().replace(/^\/+|\/+$/g, "")));
				t.inputEl.setAttribute("list", listId);
				t.inputEl.addClass("tc-modal-wide");
			});
		new Setting(contentEl)
			.setName("Re-grade existing")
			.setDesc("Also grade submissions that already have a grading note, replacing the model's part of it.")
			.addToggle((t) => t.setValue(this.regrade).onChange((v) => (this.regrade = v)));
		this.buttons(contentEl, "Grade folder", () => {
			if (!this.rubricPath) return this.showError("Pick a rubric (create one with New rubric).");
			if (!this.folders.includes(this.folder)) return this.showError(`No folder "${this.folder}" in the vault.`);
			this.finish({ rubricPath: this.rubricPath, folder: this.folder, regrade: this.regrade });
		});
	}
}

// ---------------------------------------------------------------- pick a rubric

export class RubricPickModal extends PromiseModal<string> {
	private rubricPath = "";

	constructor(
		app: App,
		private heading: string,
		private help: string,
		private rubrics: RubricChoice[],
		private initial: string,
		private label: string,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, titleEl, modalEl } = this;
		modalEl.addClass("tc-modal");
		titleEl.setText(this.heading);
		contentEl.createEl("p", { cls: "tc-modal-help", text: this.help });
		this.rubricSetting(contentEl, this.rubrics, this.initial, (p) => (this.rubricPath = p));
		this.buttons(contentEl, this.label, () => {
			if (!this.rubricPath) return this.showError("Pick a rubric (create one with New rubric).");
			this.finish(this.rubricPath);
		});
	}
}

// ---------------------------------------------------------------- progress

/** Shows progress for a long run and offers one Cancel button; `signal` aborts the work. */
export class ProgressModal extends Modal {
	private controller = new AbortController();
	private textEl: HTMLElement | null = null;
	private logEl: HTMLElement | null = null;
	private finished = false;

	constructor(
		app: App,
		private heading: string,
	) {
		super(app);
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	onOpen(): void {
		const { contentEl, titleEl, modalEl } = this;
		modalEl.addClass("tc-modal");
		modalEl.addClass("tc-progress");
		titleEl.setText(this.heading);
		this.textEl = contentEl.createEl("p", { cls: "tc-progress-text", text: "Starting…" });
		this.logEl = contentEl.createEl("pre", { cls: "tc-progress-log" });
		new Setting(contentEl).addButton((b) =>
			b.setButtonText("Cancel").onClick(() => {
				this.controller.abort();
				b.setButtonText("Cancelling…").setDisabled(true);
			}),
		);
	}

	setText(text: string): void {
		this.textEl?.setText(text);
	}

	log(line: string): void {
		if (!this.logEl) return;
		this.logEl.appendText((this.logEl.textContent ? "\n" : "") + line);
		this.logEl.scrollTop = this.logEl.scrollHeight;
	}

	/** Closes unless something was logged, so the summary stays readable. */
	finish(text: string): void {
		this.finished = true;
		this.setText(text);
		if (!this.logEl?.textContent) this.close();
		else {
			const { contentEl } = this;
			contentEl.querySelector("button")?.remove();
			new Setting(contentEl).addButton((b) => b.setButtonText("Close").setCta().onClick(() => this.close()));
		}
	}

	onClose(): void {
		if (!this.finished) this.controller.abort();
		this.contentEl.empty();
	}
}
