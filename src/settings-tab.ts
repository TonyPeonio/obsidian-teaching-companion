import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type TeachingCompanionPlugin from "./main";
import { DEFAULT_SETTINGS } from "./settings";

export class TeachingCompanionSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: TeachingCompanionPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;
		const folder = (v: string, fallback: string) => v.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") || fallback;

		new Setting(containerEl).setName("Folders").setHeading();

		new Setting(containerEl)
			.setName("Rubrics folder")
			.setDesc("Where rubric notes live. New rubric writes here; the grading commands list the notes here.")
			.addText((t) =>
				t.setPlaceholder(DEFAULT_SETTINGS.rubricsFolder).setValue(s.rubricsFolder).onChange(async (v) => {
					s.rubricsFolder = folder(v, DEFAULT_SETTINGS.rubricsFolder);
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Grading folder")
			.setDesc("Grading notes go to <folder>/<rubric>/<submission>.md and the grade book next to them. Nothing is written anywhere else.")
			.addText((t) =>
				t.setPlaceholder(DEFAULT_SETTINGS.gradingFolder).setValue(s.gradingFolder).onChange(async (v) => {
					s.gradingFolder = folder(v, DEFAULT_SETTINGS.gradingFolder);
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName("Model").setHeading();

		new Setting(containerEl)
			.setName("Ollama URL")
			.setDesc("Where Ollama is listening. Student work is sent only here; keep it on this machine.")
			.addText((t) =>
				t.setPlaceholder(DEFAULT_SETTINGS.ollamaUrl).setValue(s.ollamaUrl).onChange(async (v) => {
					s.ollamaUrl = v.trim() || DEFAULT_SETTINGS.ollamaUrl;
					await this.plugin.saveSettings();
				}),
			)
			.addButton((b) =>
				b.setButtonText("Test connection").onClick(async () => {
					try {
						const version = await this.plugin.client.version();
						const models = await this.plugin.client.listModels();
						const has = models.some((m) => m.name === s.model);
						new Notice(`Connected to Ollama ${version} (${models.length} models).${has ? "" : ` Model "${s.model}" is not installed: run \`ollama pull ${s.model}\`.`}`, 8000);
					} catch (err) {
						new Notice(`Connection failed: ${(err as Error).message}`, 8000);
					}
				}),
			);

		const modelSetting = new Setting(containerEl).setName("Chat model").setDesc("Any Ollama chat model. qwen3.5:9b fits a 12 GB GPU; a larger model grades more consistently.");
		modelSetting.addDropdown(async (d) => {
			d.addOption(s.model, s.model);
			d.setValue(s.model);
			try {
				const models = await this.plugin.client.listModels();
				d.selectEl.empty();
				const names = models.filter((m) => !/embed/i.test(m.name)).map((m) => m.name);
				if (!names.includes(s.model)) names.unshift(s.model);
				for (const n of names) d.addOption(n, n);
				d.setValue(s.model);
			} catch {
				// Ollama unreachable: keep the single current value.
			}
			d.onChange(async (v) => {
				s.model = v;
				await this.plugin.saveSettings();
			});
		});
		modelSetting.addText((t) =>
			t.setPlaceholder("or type a model name").onChange(async (v) => {
				if (!v.trim()) return;
				s.model = v.trim();
				await this.plugin.saveSettings();
			}),
		);

		new Setting(containerEl)
			.setName("Context size (num_ctx)")
			.setDesc("Tokens the model can see at once. A submission longer than this minus the rubric is cut; criteria are split over several calls when they do not fit beside it. 16384 covers about 12 pages.")
			.addText((t) =>
				t.setValue(String(s.numCtx)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (Number.isFinite(n) && n >= 2048 && n <= 262144) {
						s.numCtx = n;
						await this.plugin.saveSettings();
					}
				}),
			);

		new Setting(containerEl).setName("Comments").setHeading();

		new Setting(containerEl)
			.setName("Comments tone")
			.setDesc("Brief: one sentence per criterion from the justification. Detailed: adds the strongest quote and the next rubric level to aim for.")
			.addDropdown((d) =>
				d
					.addOption("brief", "Brief")
					.addOption("detailed", "Detailed")
					.setValue(s.commentsTone)
					.onChange(async (v) => {
						s.commentsTone = v === "detailed" ? "detailed" : "brief";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Quote the submission in comments")
			.setDesc("Include one verbatim quote from the evidence in each draft comment.")
			.addToggle((t) =>
				t.setValue(s.includeQuotesInComments).onChange(async (v) => {
					s.includeQuotesInComments = v;
					await this.plugin.saveSettings();
				}),
			);
	}
}
