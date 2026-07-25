import type { DeferredDiagnosticsEntry } from "@musepi/core";
import { type Component, Container, Text } from "@musepi/pi-tui";
import type { EntryRenderer, EntryRenderOptions } from "../../../core/extensions/types.ts";
import { type ThemeColor, theme } from "../theme/theme.ts";

// =============================================================================
// Static native entry renderer registry
// Extensions register via the runner; native features register here.
// =============================================================================

const nativeEntryRenderers = new Map<string, EntryRenderer>();

export function registerNativeEntryRenderer<T>(customType: string, renderer: EntryRenderer<T>): void {
	nativeEntryRenderers.set(customType, renderer as EntryRenderer);
}

export function getNativeEntryRenderer(customType: string): EntryRenderer | undefined {
	return nativeEntryRenderers.get(customType);
}

// =============================================================================
// Entry rendering helpers
// =============================================================================

interface ParsedDiag {
	line: number;
	col: number;
	severity: "error" | "warning" | "info" | "hint";
	message: string;
	code?: string;
}

const DIAG_LINE_RE = /^.+?:(\d+):(\d+)\s+\[(\w+)\]\s+(.+?)(?:\s+\(([^)]+)\))?$/;

function parseDiagLine(msg: string): ParsedDiag | null {
	const m = msg.match(DIAG_LINE_RE);
	if (!m) return null;
	return {
		line: Number(m[1]),
		col: Number(m[2]),
		severity: m[3] as ParsedDiag["severity"],
		message: m[4],
		code: m[5] || undefined,
	};
}

function severityColor(sev: ParsedDiag["severity"]): ThemeColor {
	switch (sev) {
		case "error":
			return "error";
		case "warning":
			return "warning";
		case "info":
			return "info";
		case "hint":
			return "dim";
	}
}

const COLLAPSED_MAX = 5;

// =============================================================================
// Component
// =============================================================================

export class LateDiagnosticsMessageComponent extends Container {
	readonly #entries: DeferredDiagnosticsEntry[];
	#expanded = false;

	constructor(entries: DeferredDiagnosticsEntry[]) {
		super();
		this.#entries = entries;
		this.#rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.#rebuild();
	}

	override invalidate(): void {
		super.invalidate();
		this.#rebuild();
	}

	#rebuild(): void {
		this.clear();
		if (this.#entries.length === 0) return;

		const hasErrors = this.#entries.some((e) => e.errored);
		const totalMessages = this.#entries.reduce((s, e) => s + e.messages.length, 0);
		const maxShow = this.#expanded ? totalMessages : Math.min(totalMessages, COLLAPSED_MAX);
		let shown = 0;

		// Header
		const headerIcon = theme.fg(hasErrors ? "error" : "warning", hasErrors ? "\u2717" : "!");
		const headerLabel = theme.fg("toolTitle", "Late diagnostics");
		const summaries = this.#entries
			.map((e) => e.summary)
			.filter(Boolean)
			.join(", ");
		const summaryTag = summaries ? ` ${theme.fg("dim", `(${summaries})`)}` : "";
		this.addChild(new Text(`\n${headerIcon} ${headerLabel}${summaryTag}`, 1, 0));

		const entryCount = this.#entries.length;
		for (let ei = 0; ei < entryCount; ei++) {
			const entry = this.#entries[ei];
			if (shown >= maxShow || entry.messages.length === 0) continue;

			const isLastEntry = ei === entryCount - 1;
			const fileBranch = theme.fg("dim", isLastEntry ? "\u2514\u2500" : "\u251C\u2500");

			// File header
			this.addChild(new Text(` ${fileBranch} ${theme.fg("accent", entry.path)}`, 1, 0));

			const msgCount = entry.messages.length;
			for (let mi = 0; mi < msgCount; mi++) {
				if (shown >= maxShow) break;
				const msg = entry.messages[mi];
				const isLastMsg = mi === msgCount - 1;
				const isLastVisible = shown === maxShow - 1;
				const willShowMoreAbove = msgCount > mi + 1 && shown + 1 < maxShow;

				// File continuation: "│ " if more entries after, "  " if last entry
				const cont = isLastEntry ? "  " : "\u2502 ";
				// Message branch: "├ " if not last msg in file, "└ " if last
				const msgBranch = isLastMsg || (isLastVisible && !willShowMoreAbove) ? "\u2514 " : "\u251C ";
				const branch = `${theme.fg("dim", cont)}${theme.fg("dim", msgBranch)}`;

				const parsed = parseDiagLine(msg);
				if (parsed) {
					const loc = theme.fg("dim", `:${parsed.line}:${parsed.col}`);
					const codeTag = parsed.code ? theme.fg("dim", ` (${parsed.code})`) : "";
					const color = severityColor(parsed.severity);
					const sevIcon = theme.fg(
						color,
						parsed.severity === "error" ? "\u2717" : parsed.severity === "warning" ? "!" : "\u00B7",
					);
					this.addChild(new Text(` ${branch}${sevIcon}${loc} ${theme.fg(color, parsed.message)}${codeTag}`, 1, 0));
				} else {
					this.addChild(new Text(` ${branch}${theme.fg("dim", msg)}`, 1, 0));
				}
				shown++;

				if (shown >= maxShow && totalMessages > maxShow) {
					const remaining = totalMessages - maxShow;
					this.addChild(
						new Text(
							` ${theme.fg("dim", isLastEntry ? "  " : "\u2502 ")}${theme.fg("dim", "\u2514")} ${theme.fg(
								"muted",
								`\u2026 ${remaining} more`,
							)}`,
							1,
							0,
						),
					);
					return;
				}
			}
		}
	}
}

// =============================================================================
// Renderer factory for the native entry renderer registry
// =============================================================================

export const lateDiagnosticsEntryRenderer: EntryRenderer<{
	files: DeferredDiagnosticsEntry[];
}> = (entry, options: EntryRenderOptions, _theme): Component | undefined => {
	const data = entry.data as { files?: DeferredDiagnosticsEntry[] } | undefined;
	if (!data?.files?.length) return undefined;
	const component = new LateDiagnosticsMessageComponent(data.files);
	component.setExpanded(options.expanded);
	return component;
};
