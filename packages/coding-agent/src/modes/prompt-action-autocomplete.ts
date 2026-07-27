import {
	type AutocompleteItem,
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	getKeybindings,
	type KeyId,
	type SlashCommand,
} from "@musepi/pi-tui";
import type { KeybindingsManager } from "../core/keybindings.ts";

// ── Types ──────────────────────────────────────────────────────────────────

interface PromptActionDefinition {
	id: string;
	label: string;
	description: string;
	keywords: string[];
	execute: (prefix: string) => void;
}

interface PromptActionAutocompleteItem extends AutocompleteItem {
	actionId: string;
	execute: (prefix: string) => void;
}

export interface PromptActionAutocompleteOptions {
	commands: SlashCommand[];
	basePath: string;
	keybindings: KeybindingsManager;
	copyCurrentLine: () => void;
	copyPrompt: () => void;
	undo: (prefix: string) => void;
	moveCursorToMessageEnd: () => void;
	moveCursorToMessageStart: () => void;
	moveCursorToLineStart: () => void;
	moveCursorToLineEnd: () => void;
}

// ── Fuzzy matching helpers ──────────────────────────────────────────────────

function fuzzyMatch(query: string, target: string): boolean {
	if (query.length === 0) return true;
	if (query.length > target.length) return false;
	let qi = 0;
	for (let ti = 0; ti < target.length && qi < query.length; ti++) {
		if (query[qi] === target[ti]) qi++;
	}
	return qi === query.length;
}

function fuzzyScore(query: string, target: string): number {
	if (query.length === 0) return 1;
	if (target === query) return 100;
	if (target.startsWith(query)) return 80;
	if (target.includes(query)) return 60;
	let qi = 0;
	let gaps = 0;
	let lastMatch = -1;
	for (let ti = 0; ti < target.length && qi < query.length; ti++) {
		if (query[qi] !== target[ti]) continue;
		if (lastMatch >= 0 && ti - lastMatch > 1) gaps++;
		lastMatch = ti;
		qi++;
	}
	if (qi !== query.length) return 0;
	return Math.max(1, 40 - gaps * 5);
}

function isPromptActionItem(item: AutocompleteItem): item is PromptActionAutocompleteItem {
	return "actionId" in item && "execute" in item && typeof item.execute === "function";
}

/** Detect #-prefix prompt-action trigger in text before cursor. */
function getPromptActionPrefix(textBeforeCursor: string): string | null {
	const hashIndex = textBeforeCursor.lastIndexOf("#");
	if (hashIndex === -1) return null;
	const query = textBeforeCursor.slice(hashIndex + 1);
	if (/[\s]/.test(query)) return null;
	return textBeforeCursor.slice(hashIndex);
}

// ── Provider ────────────────────────────────────────────────────────────────

/**
 * Autocomplete provider that extends slash-command completion with
 * `#`-triggered prompt actions (copy line, undo, cursor movement, etc.)
 *
 * Wraps CombinedAutocompleteProvider for base slash-command completion
 * and adds prompt actions when the user types `#`.
 */
export class PromptActionAutocompleteProvider implements AutocompleteProvider {
	readonly #baseProvider: CombinedAutocompleteProvider;
	readonly #actions: PromptActionDefinition[];

	constructor(commands: SlashCommand[], basePath: string, actions: PromptActionDefinition[]) {
		this.#baseProvider = new CombinedAutocompleteProvider(commands, basePath);
		this.#actions = actions;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		const textBeforeCursor = (lines[cursorLine] || "").slice(0, cursorCol);

		// Check for #-prefix prompt actions
		const promptActionPrefix = getPromptActionPrefix(textBeforeCursor);
		if (promptActionPrefix) {
			const query = promptActionPrefix.slice(1).toLowerCase();
			const items = this.#actions
				.map((action) => {
					const searchable = [action.label, action.description, ...action.keywords].join(" ").toLowerCase();
					if (!fuzzyMatch(query, searchable)) return null;
					return {
						value: action.label,
						label: action.label,
						description: action.description,
						actionId: action.id,
						execute: action.execute,
						score: fuzzyScore(query, searchable),
					} satisfies PromptActionAutocompleteItem & { score: number };
				})
				.filter((item): item is NonNullable<typeof item> => item !== null)
				.sort((a, b) => b.score - a.score)
				.map(({ score: _score, ...item }) => item);
			if (items.length > 0) return { items, prefix: promptActionPrefix };
		}

		return this.#baseProvider.getSuggestions(lines, cursorLine, cursorCol, { signal: new AbortController().signal });
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): {
		lines: string[];
		cursorLine: number;
		cursorCol: number;
		onApplied?: () => void;
	} {
		if (prefix.startsWith("#") && isPromptActionItem(item)) {
			if (item.actionId === "undo") {
				// Undo keeps the prefix so the action can restore editor state
				return { lines, cursorLine, cursorCol, onApplied: () => item.execute(prefix) };
			}
			// Remove # prefix from editor, then execute action
			const currentLine = lines[cursorLine] || "";
			const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
			const afterCursor = currentLine.slice(cursorCol);
			const newLines = [...lines];
			newLines[cursorLine] = beforePrefix + afterCursor;
			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length,
				onApplied: () => item.execute(prefix),
			};
		}
		return this.#baseProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	}
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createPromptActionAutocompleteProvider(
	options: PromptActionAutocompleteOptions,
): PromptActionAutocompleteProvider {
	const editorKeys = getKeybindings();

	// Compute formatted key-display strings once
	const fmt = (keys: KeyId[]) =>
		keys.length === 0
			? ""
			: keys
					.map((k) =>
						k
							.split("+")
							.map((part) => {
								const p = process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
								return p.charAt(0).toUpperCase() + p.slice(1);
							})
							.join("+"),
					)
					.join("/");

	const copyLineKeys = fmt(options.keybindings.getKeys("app.clipboard.copyLine"));
	const copyPromptKeys = fmt(options.keybindings.getKeys("app.clipboard.copyPrompt"));
	const undoKeys = fmt(editorKeys.getKeys("tui.editor.undo"));
	const cursorLineStartKeys = fmt(editorKeys.getKeys("tui.editor.cursorLineStart"));
	const cursorLineEndKeys = fmt(editorKeys.getKeys("tui.editor.cursorLineEnd"));

	const actions: PromptActionDefinition[] = [
		{
			id: "copy-line",
			label: "Copy current line",
			description: copyLineKeys,
			keywords: ["copy", "line", "clipboard", "current"],
			execute: options.copyCurrentLine,
		},
		{
			id: "copy-prompt",
			label: "Copy whole prompt",
			description: copyPromptKeys,
			keywords: ["copy", "prompt", "clipboard", "message"],
			execute: options.copyPrompt,
		},
		{
			id: "undo",
			label: "Undo",
			description: undoKeys,
			keywords: ["undo", "revert", "edit", "history"],
			execute: options.undo,
		},
		{
			id: "cursor-message-end",
			label: "Move cursor to end of message",
			description: "Current message",
			keywords: ["move", "cursor", "message", "end", "prompt", "last", "bottom"],
			execute: options.moveCursorToMessageEnd,
		},
		{
			id: "cursor-message-start",
			label: "Move cursor to beginning of message",
			description: "Current message",
			keywords: ["move", "cursor", "message", "start", "beginning", "prompt", "first", "top"],
			execute: options.moveCursorToMessageStart,
		},
		{
			id: "cursor-line-start",
			label: "Move cursor to beginning of line",
			description: cursorLineStartKeys,
			keywords: ["move", "cursor", "line", "start", "beginning", "home"],
			execute: options.moveCursorToLineStart,
		},
		{
			id: "cursor-line-end",
			label: "Move cursor to end of line",
			description: cursorLineEndKeys,
			keywords: ["move", "cursor", "line", "end"],
			execute: options.moveCursorToLineEnd,
		},
	];
	return new PromptActionAutocompleteProvider(options.commands, options.basePath, actions);
}
