import type { CommentTone } from "./core/comments";

export interface TeachingCompanionSettings {
	rubricsFolder: string;
	gradingFolder: string;
	ollamaUrl: string;
	model: string;
	numCtx: number;
	commentsTone: CommentTone;
	includeQuotesInComments: boolean;
	/** Last rubric picked in a modal, so the next one starts there. */
	lastRubric: string;
	lastSubmissionsFolder: string;
}

export const DEFAULT_SETTINGS: TeachingCompanionSettings = {
	rubricsFolder: "Teaching/Rubrics",
	gradingFolder: "Teaching/Grading",
	ollamaUrl: "http://localhost:11434",
	model: "qwen3.5:9b",
	numCtx: 16384,
	commentsTone: "brief",
	includeQuotesInComments: true,
	lastRubric: "",
	lastSubmissionsFolder: "",
};
