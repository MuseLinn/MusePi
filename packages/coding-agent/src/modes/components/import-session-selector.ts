/**
 * `/import-session` TUI selector — two-step interactive flow:
 *  1. Select source agent (claude, codex, musepi, omp, …)
 *  2. Select session from that source → persist
 *
 * Reuses the CLI `musepi import` backend (createForeignSessionStore /
 * persistForeignSession) but with a TUI picker UX instead of args.
 */

import {
	type Component,
	Container,
	matchesKey,
	Spacer,
	Text,
} from "@musepi/pi-tui";
import { theme } from "../../modes/theme/theme";
import {
	matchesAppInterrupt,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../../modes/utils/keybinding-matchers";
import { getAgentDir, getProjectDir } from "@musepi/pi-utils";
import { createForeignSessionStore, foreignSessionSources, persistForeignSession } from "../../session/foreign-session-import";
import type { ForeignSessionSource } from "../../session/foreign-session-store";
import { DynamicBorder } from "./dynamic-border";
import { rawKeyHint } from "./keybinding-hints";
import { centeredWindow, renderScrollableList } from "./selector-helpers";

const MAX_VISIBLE = 12;
const LIST_WIDTH = 80;

type Phase = "source" | "session" | "importing" | "done";

interface ImportSessionEntry {
	id: string;
	path: string;
	title: string;
	messageCount: number;
}

function sourceName(source: ForeignSessionSource): string {
	switch (source) {
		case "claude": return "Claude";
		case "codex": return "Codex";
		case "grok": return "Grok";
		case "kimicode": return "Kimi Code";
		case "musepi": return "MusePi";
		case "omp": return "OMP";
		case "opencode": return "OpenCode";
		case "pi": return "Pi";
	}
}

export class ImportSessionSelector extends Container {
	#phase: Phase = "source";
	#sources: readonly ForeignSessionSource[];
	#sessions: ImportSessionEntry[] = [];
	#selectedIndex = 0;
	#scrollOffset = 0;
	#done: () => void;
	#onCancel: () => void;
	#errorMessage: string | null = null;
	#successMessage: string | null = null;
	#selectedSource: ForeignSessionSource | null = null;

	constructor(done: () => void, onCancel: () => void) {
		super();
		this.#done = done;
		this.#onCancel = onCancel;
		this.#sources = foreignSessionSources();
		this.#render();
	}

	handleInput(keyData: string): void {
		if (this.#phase === "importing" || this.#phase === "done") {
			if (matchesAppInterrupt(keyData) || matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
				this.#done();
			}
			return;
		}

		if (matchesSelectUp(keyData)) {
			const count = this.#phase === "source" ? this.#sources.length : this.#sessions.length;
			if (count === 0) return;
			this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
			this.#centerWindow();
			this.#render();
			return;
		}

		if (matchesSelectDown(keyData)) {
			const count = this.#phase === "source" ? this.#sources.length : this.#sessions.length;
			if (count === 0) return;
			this.#selectedIndex = Math.min(count - 1, this.#selectedIndex + 1);
			this.#centerWindow();
			this.#render();
			return;
		}

		if (matchesSelectPageUp(keyData)) {
			const count = this.#phase === "source" ? this.#sources.length : this.#sessions.length;
			if (count === 0) return;
			this.#selectedIndex = Math.max(0, this.#selectedIndex - MAX_VISIBLE);
			this.#centerWindow();
			this.#render();
			return;
		}

		if (matchesSelectPageDown(keyData)) {
			const count = this.#phase === "source" ? this.#sources.length : this.#sessions.length;
			if (count === 0) return;
			this.#selectedIndex = Math.min(count - 1, this.#selectedIndex + MAX_VISIBLE);
			this.#centerWindow();
			this.#render();
			return;
		}

		if (matchesKey(keyData, "home") || matchesKey(keyData, "end")) {
			const count = this.#phase === "source" ? this.#sources.length : this.#sessions.length;
			if (count === 0) return;
			this.#selectedIndex = matchesKey(keyData, "end") ? count - 1 : 0;
			this.#centerWindow();
			this.#render();
			return;
		}

		if (matchesAppInterrupt(keyData)) {
			if (this.#phase === "session") {
				this.#phase = "source";
				this.#selectedIndex = 0;
				this.#errorMessage = null;
				this.#render();
				return;
			}
			this.#onCancel();
			return;
		}

		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			if (this.#phase === "source") {
				const source = this.#sources[this.#selectedIndex];
				this.#selectedSource = source;
				this.#loadSessions(source);
				return;
			}
			if (this.#phase === "session") {
				const session = this.#sessions[this.#selectedIndex];
				if (!session) return;
				this.#importSession(session);
				return;
			}
		}
	}

	async #loadSessions(source: ForeignSessionSource): Promise<void> {
		this.#phase = "importing";
		this.#errorMessage = null;
		this.#render();
		const store = createForeignSessionStore(source);
		try {
			const sessions = await store.list();
			this.#sessions = sessions.map(s => ({
				id: s.id,
				path: s.path,
				title: s.title ?? "",
				messageCount: s.messageCount ?? 0,
			}));
			this.#selectedIndex = 0;
			this.#scrollOffset = 0;
			this.#phase = "session";
		} catch (error) {
			this.#errorMessage = `Failed to scan ${sourceName(source)}: ${(error as Error).message}`;
			this.#phase = "source";
		}
		this.#render();
	}

	async #importSession(session: ImportSessionEntry): Promise<void> {
		if (!this.#selectedSource) return;
		this.#phase = "importing";
		this.#errorMessage = null;
		this.#render();
		const store = createForeignSessionStore(this.#selectedSource);
		const sessions = await store.list();
		const match = sessions.find(s => s.id === session.id);
		if (!match) {
			this.#errorMessage = `Session ${session.id} not found (changed between list and import).`;
			this.#phase = "session";
			this.#render();
			return;
		}
		try {
			await persistForeignSession(store, match, {
				fallbackCwd: getProjectDir(),
				sessionDir: getAgentDir(),
				suppressBreadcrumb: true,
			});
			this.#successMessage = `Imported ${session.id} from ${sourceName(this.#selectedSource)}`;
			this.#phase = "done";
		} catch (error) {
			this.#errorMessage = `Import failed: ${(error as Error).message}`;
			this.#phase = "session";
		}
		this.#render();
	}

	#centerWindow(): void {
		const count = this.#phase === "source" ? this.#sources.length : this.#sessions.length;
		const window = centeredWindow(this.#selectedIndex, count, MAX_VISIBLE);
		this.#scrollOffset = window.startIndex;
	}

	#render(): void {
		this.clear();
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold(theme.fg("accent", "Import Session")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		if (this.#phase === "importing") {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", "Loading..."), 1, 0));
			this.addChild(new Spacer(1));
			this.addChild(new DynamicBorder());
			this.addChild(new Spacer(1));
			return;
		}

		if (this.#errorMessage) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("error", `⚠ ${this.#errorMessage}`), 1, 0));
			this.addChild(new Spacer(1));
		}

		if (this.#phase === "done" && this.#successMessage) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("success", `✓ ${this.#successMessage}`), 1, 0));
			this.addChild(new Spacer(1));
			this.addChild(new DynamicBorder());
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", "Press Enter or Esc to close"), 1, 0));
			this.addChild(new Spacer(1));
			return;
		}

		if (this.#phase === "source") {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", "Select source agent:"), 1, 0));
			this.addChild(new Spacer(1));
			this.#renderSourceList();
		} else if (this.#phase === "session") {
			this.addChild(new Spacer(1));
			const sourceLabel = this.#selectedSource ? sourceName(this.#selectedSource) : "";
			this.addChild(new Text(theme.fg("dim", `Select a session from ${sourceLabel}:`), 1, 0));
			this.addChild(new Spacer(1));
			this.#renderSessionList();
		}

		this.addChild(new Spacer(1));
		this.addChild(new Text(this.#hintBar(), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	#renderSourceList(): void {
		const rows = this.#sources.map((source, i) => {
			const name = sourceName(source);
			const prefix = i === this.#selectedIndex ? theme.fg("accent", "❯ ") : "  ";
			const label = i === this.#selectedIndex ? theme.bold(theme.fg("accent", name)) : theme.fg("text", name);
			return `${prefix}${label}`;
		});
		const rendered = renderScrollableList(rows, {
			width: LIST_WIDTH,
			totalRows: rows.length,
			scrollOffset: this.#scrollOffset,
		});
		for (const row of rendered) {
			this.addChild(new Text(row, 1, 0));
		}
	}

	#renderSessionList(): void {
		if (this.#sessions.length === 0) {
			this.addChild(new Text(theme.fg("dim", "No sessions found."), 1, 0));
			return;
		}
		const { startIndex, endIndex } = centeredWindow(this.#selectedIndex, this.#sessions.length, MAX_VISIBLE);
		for (let i = startIndex; i < endIndex && i < this.#sessions.length; i++) {
			const s = this.#sessions[i];
			const prefix = i === this.#selectedIndex ? theme.fg("accent", "❯ ") : "  ";
			const idLabel = i === this.#selectedIndex ? theme.bold(s.id) : s.id;
			const title = s.title ? ` — ${theme.fg("dim", s.title)}` : "";
			const count = s.messageCount > 0 ? theme.fg("muted", ` (${s.messageCount})`) : "";
			this.addChild(new Text(`${prefix}${idLabel}${title}${count}`, 1, 0));
		}
	}

	#hintBar(): string {
		const dot = theme.fg("dim", theme.sep.dot);
		if (this.#phase === "source") {
			return [rawKeyHint("↑↓", "navigate"), rawKeyHint("enter", "select"), rawKeyHint("esc", "cancel")].join(dot);
		}
		if (this.#phase === "session") {
			return [rawKeyHint("↑↓", "navigate"), rawKeyHint("enter", "import"), rawKeyHint("esc", "back")].join(dot);
		}
		if (this.#phase === "done") {
			return [rawKeyHint("enter", "close")].join(dot);
		}
		return "";
	}
}