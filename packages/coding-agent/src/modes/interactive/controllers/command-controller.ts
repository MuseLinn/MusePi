/**
 * Command Controller — slash command handler dispatch.
 *
 * Ported from OMP's command-controller.ts. Owns all `/cmd` route
 * implementations, delegating to context methods for session/UI access.
 */

import { Markdown, Spacer, Text } from "@musepi/pi-tui";
import { handleMusepiMcpCommand } from "../../../musepi/mcp-native.ts";
import { handleMusepiMemoryCommand, initMusepiMemory } from "../../../musepi/memory-native.ts";
import {
	type ChangelogEntry,
	getChangelogPath,
	normalizeChangelogLinks,
	parseChangelog,
} from "../../../utils/changelog.ts";
import { copyToClipboard } from "../../../utils/clipboard.ts";
import { DynamicBorder } from "../components/dynamic-border.ts";
import type { InteractiveModeContext } from "../types.ts";

function showMarkdownPanel(ctx: InteractiveModeContext, title: string, markdown: string): void {
	const fullMarkdown = markdown.trim();
	if (!fullMarkdown) {
		ctx.showWarning("No content to display.");
		return;
	}
	ctx.chatContainer.addChild(new Spacer(1));
	ctx.chatContainer.addChild(new DynamicBorder());
	ctx.chatContainer.addChild(new Text(ctx.theme.bold(ctx.theme.fg("accent", title)), 1, 0));
	ctx.chatContainer.addChild(new Spacer(1));
	ctx.chatContainer.addChild(new Markdown(fullMarkdown, 1, 1, ctx.getMarkdownTheme()));
	ctx.chatContainer.addChild(new DynamicBorder());
	ctx.requestRender();
}

export class CommandController {
	readonly #ctx: InteractiveModeContext;

	constructor(ctx: InteractiveModeContext) {
		this.#ctx = ctx;
	}

	dispose(): void {
		// Nothing to dispose yet
	}

	// ── Session / navigation ──────────────────────────────────────

	async handleClearCommand(): Promise<void> {
		this.#ctx.clearStatusIndicator();
		try {
			const result = await this.#ctx.runtimeHost.newSession();
			if (result.cancelled) return;
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			this.#ctx.showError(`Failed to start new session: ${message}`);
		}
	}

	async handleCloneCommand(): Promise<void> {
		const leafId = this.#ctx.sessionManager.getLeafId();
		if (!leafId) {
			this.#ctx.showStatus("Nothing to clone yet");
			return;
		}

		try {
			const result = await this.#ctx.runtimeHost.fork(leafId, { position: "at" });
			if (result.cancelled) {
				this.#ctx.requestRender();
				return;
			}

			this.#ctx.showStatus("Cloned to new session");
		} catch (error: unknown) {
			this.#ctx.showError(error instanceof Error ? error.message : String(error));
		}
	}

	async handleExportCommand(text: string): Promise<void> {
		const outputPath =
			text === "/export"
				? undefined
				: text.startsWith("/export ")
					? this.#parsePathArg(text.slice(8).trim())
					: undefined;

		try {
			if (outputPath?.endsWith(".jsonl")) {
				const filePath = this.#ctx.session.exportToJsonl(outputPath);
				this.#ctx.showStatus(`Session exported to: ${filePath}`);
			} else {
				const filePath = await this.#ctx.session.exportToHtml(outputPath);
				this.#ctx.showStatus(`Session exported to: ${filePath}`);
			}
		} catch (error: unknown) {
			this.#ctx.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	#parsePathArg(argString: string): string | undefined {
		if (!argString) return undefined;
		const firstChar = argString[0];
		if (firstChar === '"' || firstChar === "'") {
			const closing = argString.indexOf(firstChar, 1);
			return closing < 0 ? undefined : argString.slice(1, closing);
		}
		const ws = argString.search(/\s/);
		return ws < 0 ? argString : argString.slice(0, ws);
	}

	async handleCopyCommand(): Promise<void> {
		const text = this.#ctx.session.getLastAssistantText();
		if (!text) {
			this.#ctx.showError("No agent messages to copy yet.");
			return;
		}

		try {
			await copyToClipboard(text);
			this.#ctx.showStatus("Copied last agent message to clipboard");
		} catch (error) {
			this.#ctx.showError(error instanceof Error ? error.message : String(error));
		}
	}

	handleSessionCommand(): void {
		const sessionManager = this.#ctx.sessionManager;
		const cwd = sessionManager.getCwd();
		const leafId = sessionManager.getLeafId();
		const sessionName = sessionManager.getSessionName();

		const info = [`**Name:** ${sessionName ?? "unnamed"}`, `**CWD:** ${cwd}`, leafId ? `**Leaf:** ${leafId}` : ""]
			.filter(Boolean)
			.join("\n");

		showMarkdownPanel(this.#ctx, "Session Info", info);
	}

	handleNameCommand(text: string): void {
		const name = text.startsWith("/name ") ? text.slice(6).trim() : "";
		if (!name) {
			this.#ctx.showWarning("Usage: /name <name>");
			return;
		}
		this.#ctx.session.setSessionName(name);
		this.#ctx.showStatus(`Session renamed to: ${name}`);
	}

	// ── Changelog ─────────────────────────────────────────────────

	async handleChangelogCommand(): Promise<void> {
		const changelogPath = getChangelogPath();
		const allEntries = parseChangelog(changelogPath);

		const changelogMarkdown =
			allEntries.length > 0
				? allEntries
						.reverse()
						.map((e: ChangelogEntry) => normalizeChangelogLinks(e.content, e))
						.join("\n\n")
				: "No changelog entries found.";

		this.#ctx.chatContainer.addChild(new Spacer(1));
		this.#ctx.chatContainer.addChild(new DynamicBorder());
		this.#ctx.chatContainer.addChild(
			new Text(this.#ctx.theme.bold(this.#ctx.theme.fg("accent", "What's New")), 1, 0),
		);
		this.#ctx.chatContainer.addChild(new Spacer(1));
		this.#ctx.chatContainer.addChild(new Markdown(changelogMarkdown, 1, 1, this.#ctx.getMarkdownThemeWithSettings()));
		this.#ctx.chatContainer.addChild(new DynamicBorder());
		this.#ctx.requestRender();
	}

	// ── MCP ───────────────────────────────────────────────────────

	async handleMcpCommand(args: string): Promise<void> {
		try {
			const output = await handleMusepiMcpCommand(args);
			this.#ctx.chatContainer.addChild(new Spacer(1));
			this.#ctx.chatContainer.addChild(new Text(this.#ctx.theme.fg("dim", output), 1, 0));
		} catch (error) {
			this.#ctx.showError(`MCP command failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.#ctx.requestRender();
	}

	// ── Memory ────────────────────────────────────────────────────

	async handleMemoryCommand(args: string): Promise<void> {
		try {
			const [action = "", target = ""] = args.trim().split(/\s+/, 2);
			let confirmed = false;
			if (action === "clear" && ["project", "global", "all"].includes(target)) {
				confirmed = await this.#ctx.showExtensionConfirm(
					"Clear memory",
					`Reset ${target} memory to the empty skeleton? This cannot be undone.`,
				);
				if (!confirmed) {
					this.#ctx.showStatus("Memory clear cancelled.");
					return;
				}
			}
			const output = handleMusepiMemoryCommand(args, {
				confirmed,
				setEnabled: (enabled: boolean) => {
					this.#ctx.settingsManager.setMusepiMemoryEnabled(enabled);
					initMusepiMemory(this.#ctx.session, this.#ctx.settingsManager);
				},
			});
			this.#ctx.chatContainer.addChild(new Spacer(1));
			this.#ctx.chatContainer.addChild(new Text(this.#ctx.theme.fg("dim", output), 1, 0));
		} catch (error) {
			this.#ctx.showError(`Memory command failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.#ctx.requestRender();
	}

	// ── Display / info ────────────────────────────────────────────

	handleHotkeysCommand(): void {
		const d = (action: string) => this.#ctx.getEditorKeyDisplay(action);
		const a = (action: string) => this.#ctx.getAppKeyDisplay(action);

		const hotkeys = [
			"**Navigation**",
			"| Key | Action |",
			"|-----|--------|",
			`| \`${d("tui.editor.cursorUp")}\` / \`${d("tui.editor.cursorDown")}\` / \`${d("tui.editor.cursorLeft")}\` / \`${d("tui.editor.cursorRight")}\` | Move cursor / browse history |`,
			`| \`${d("tui.editor.cursorWordLeft")}\` / \`${d("tui.editor.cursorWordRight")}\` | Move by word |`,
			`| \`${d("tui.editor.cursorLineStart")}\` | Start of line |`,
			`| \`${d("tui.editor.cursorLineEnd")}\` | End of line |`,
			`| \`${d("tui.editor.jumpForward")}\` | Jump forward to character |`,
			`| \`${d("tui.editor.jumpBackward")}\` | Jump backward to character |`,
			`| \`${d("tui.editor.pageUp")}\` / \`${d("tui.editor.pageDown")}\` | Scroll by page |`,
			"",
			"**Editing**",
			"| Key | Action |",
			"|-----|--------|",
			`| \`${d("tui.input.submit")}\` | Send message |`,
			`| \`${d("tui.input.newLine")}\` | New line${process.platform === "win32" ? " (Ctrl+Enter on Windows Terminal)" : ""} |`,
			`| \`${d("tui.editor.deleteWordBackward")}\` | Delete word backwards |`,
			`| \`${d("tui.editor.deleteWordForward")}\` | Delete word forwards |`,
			`| \`${d("tui.editor.deleteToLineStart")}\` | Delete to start of line |`,
			`| \`${d("tui.editor.deleteToLineEnd")}\` | Delete to end of line |`,
			`| \`${d("tui.editor.yank")}\` | Paste the most-recently-deleted text |`,
			`| \`${d("tui.editor.yankPop")}\` | Cycle through the deleted text after pasting |`,
			`| \`${d("tui.editor.undo")}\` | Undo |`,
			"",
			"**Other**",
			"| Key | Action |",
			"|-----|--------|",
			`| \`${d("tui.input.tab")}\` | Path completion / accept autocomplete |`,
			`| \`${a("app.interrupt")}\` | Cancel autocomplete / abort streaming |`,
			`| \`${a("app.clear")}\` | Clear editor (first) / exit (second) |`,
			`| \`${a("app.exit")}\` | Exit (when editor is empty) |`,
			`| \`${a("app.suspend")}\` | Suspend to background |`,
			`| \`${a("app.thinking.cycle")}\` | Cycle thinking level |`,
			`| \`${a("app.model.cycleForward")}\` / \`${a("app.model.cycleBackward")}\` | Cycle models |`,
			`| \`${a("app.model.select")}\` | Open model selector |`,
			`| \`${a("app.tools.expand")}\` | Toggle tool output expansion |`,
			`| \`${a("app.thinking.toggle")}\` | Toggle thinking block visibility |`,
			`| \`${a("app.editor.external")}\` | Edit message in external editor |`,
			`| \`${a("app.message.copy")}\` | Copy last assistant message |`,
			`| \`${a("app.message.followUp")}\` | Queue follow-up message |`,
			`| \`${a("app.message.dequeue")}\` | Restore queued messages |`,
			`| \`${a("app.clipboard.pasteImage")}\` | Paste image or text from clipboard |`,
			"| `/` | Slash commands |",
			"| `!` | Run bash command |",
			"| `!!` | Run bash command (excluded from context) |",
		].join("\n");

		showMarkdownPanel(this.#ctx, "Keyboard Shortcuts", hotkeys);
	}
}
