/**
 * AgentDashboard — full-screen agent browser and inspector.
 *
 * Two-column layout:
 *   Left pane: agent list with source tab filters (All/Bundled/User/Project)
 *   Right pane: detail inspector (description, source, model, prewalk, prompt)
 *
 * Implements the Component interface from @musepi/pi-tui:
 *   render(width: number): string[];
 *   invalidate(): void;
 *   handleInput?(data: string): void;
 */

import { matchesKey, type Tab, TabBar } from "@musepi/pi-tui";
import { type AgentRegistryEntry, agentRegistry } from "../../../agents/registry.ts";
import { theme } from "../theme/theme.ts";
import { bottomBorder, topBorder } from "./overlay-box.ts";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface AgentDashboardCallbacks {
	onClose: () => void;
}

type AgentFilter = "all" | "bundled" | "user" | "project";

// ─── AgentDashboard Component ───────────────────────────────────────────────

export class AgentDashboard {
	private callbacks: AgentDashboardCallbacks;
	private filter: AgentFilter = "all";
	private selectedName: string | null = null;
	private agents: AgentRegistryEntry[] = [];

	constructor(callbacks: AgentDashboardCallbacks) {
		this.callbacks = callbacks;
		this.refresh();
	}

	invalidate(): void {
		this._invalidated = true;
	}

	/** Re-query the registry for the current filter. */
	private refresh(): void {
		this.agents = this.filter === "all" ? agentRegistry.list() : agentRegistry.list(this.filter);
		if (this.selectedName && !this.agents.some((a) => a.definition.name === this.selectedName)) {
			this.selectedName = this.agents.length > 0 ? this.agents[0].definition.name : null;
		} else if (!this.selectedName && this.agents.length > 0) {
			this.selectedName = this.agents[0].definition.name;
		}
	}

	/** Select a different source filter. */
	setFilter(filter: AgentFilter): void {
		this.filter = filter;
		this.refresh();
	}

	/** Select an agent by name (for keyboard nav). */
	selectAgent(name: string): void {
		if (this.agents.some((a) => a.definition.name === name)) {
			this.selectedName = name;
		}
	}

	// ─── Keyboard input ─────────────────────────────────────────

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.callbacks.onClose();
			return;
		}
		if (matchesKey(data, "tab")) {
			// Next agent in the list
			const currentIndex = this.agents.findIndex((a) => a.definition.name === this.selectedName);
			const nextIndex = (currentIndex + 1) % this.agents.length;
			this.selectedName = this.agents[nextIndex].definition.name;
			return;
		}
		if (matchesKey(data, "shift+tab")) {
			// Previous agent in the list
			const currentIndex = this.agents.findIndex((a) => a.definition.name === this.selectedName);
			const prevIndex = (currentIndex - 1 + this.agents.length) % this.agents.length;
			this.selectedName = this.agents[prevIndex].definition.name;
			return;
		}
	}

	// ─── Component interface ────────────────────────────────────────

	render(width: number): string[] {
		const paneWidth = Math.floor(width / 2) - 2;
		const leftWidth = paneWidth - 1;
		const rightWidth = width - paneWidth - 4;

		const lines: string[] = [];

		// Top border
		lines.push(topBorder(width, " Agents "));

		// Body: two columns side by side
		const leftLines = this.renderLeftPane(leftWidth);
		const rightLines = this.renderRightPane(rightWidth);
		const maxLines = Math.max(leftLines.length, rightLines.length);

		for (let i = 0; i < maxLines; i++) {
			const leftCol = i < leftLines.length ? leftLines[i] : " ".repeat(leftWidth);
			const separator = theme.fg("border", "\u2502");
			const rightCol = i < rightLines.length ? rightLines[i] : "";
			lines.push(`${leftCol}${separator}${rightCol}`);
		}

		// Bottom border
		lines.push(bottomBorder(width));

		// Quick help
		lines.push(theme.fg("muted", `  ${theme.dim("Esc to close")}    ${theme.dim("Tab/Shift+Tab: navigate")}`));

		return lines;
	}

	private renderLeftPane(width: number): string[] {
		const lines: string[] = [];

		// Source tab bar
		const tabs: Tab[] = [
			{ label: "All", id: "all" },
			{ label: "Bundled", id: "bundled" },
			{ label: "User", id: "user" },
			{ label: "Project", id: "project" },
		];
		const tabBar = new TabBar(tabs, {
			onSelect: (tab) => this.setFilter(tab.id as AgentFilter),
		});
		tabBar.selectTab(tabs.findIndex((t) => t.id === this.filter));
		lines.push(...tabBar.render(width));

		// Header
		lines.push(theme.fg("border", ` ${theme.bold("Agent")}`.padEnd(width)));
		lines.push(theme.fg("border", ` ${theme.alpha.char.repeat(width - 2)}`));

		// Agent list
		for (const entry of this.agents) {
			const isSelected = entry.definition.name === this.selectedName;
			const name = entry.definition.name;
			const prefix = isSelected ? theme.bold(theme.fg("accent", "\u25b8 ")) : "  ";
			const nameText = isSelected ? theme.bold(name) : name;
			const modelInfo = entry.runtimeModelOverride
				? theme.dim(theme.fg("muted", ` [${entry.runtimeModelOverride}]`))
				: "";
			const enabledIcon = entry.enabled ? theme.fg("success", "\u25cf") : theme.fg("muted", "\u25cb");

			const padded = `${prefix}${enabledIcon} ${nameText}${modelInfo}`.padEnd(width).slice(0, width);
			lines.push(theme.fg(isSelected ? "selectionBg" : "fg", padded));
			lines.push(theme.dim(theme.fg("muted", `   ${entry.definition.description}`)));
		}

		return lines;
	}

	private renderRightPane(width: number): string[] {
		const lines: string[] = [];
		const entry = this.selectedName ? agentRegistry.get(this.selectedName) : undefined;

		if (!entry) {
			lines.push(" ".repeat(width));
			lines.push(theme.dim(theme.fg("muted", "  No agent selected")));
			return lines;
		}

		const def = entry.definition;

		// Agent name header
		lines.push(` ${theme.bold(def.name)}`);
		lines.push(theme.fg("border", ` ${theme.alpha.char.repeat(Math.min(width - 2, 40))}`));

		// Source badge
		const sourceColors: Record<string, string> = {
			bundled: "info",
			user: "accent",
			project: "warning",
			extension: "success",
		};
		lines.push(
			`  ${theme.fg(sourceColors[def.source] ?? ("muted" as any), def.source)}  ${theme.dim(theme.fg("muted", "source"))}`,
		);

		// Description
		lines.push("");
		lines.push(`  ${def.description}`);

		// Enabled status
		const statusIcon = entry.enabled ? theme.fg("success", "\u25cf Enabled") : theme.fg("muted", "\u25cb Disabled");
		lines.push(`  ${statusIcon}`);

		// Model info
		const modelOverride = entry.runtimeModelOverride;
		const defModels = def.model ?? [];
		if (modelOverride) {
			lines.push(
				`  Model: ${theme.fg("accent", modelOverride)} ${theme.dim(theme.fg("muted", "(runtime override)"))}`,
			);
		} else if (defModels.length > 0) {
			const modelsStr = defModels.slice(0, 3).join(", ");
			const suffix = defModels.length > 3 ? ` +${defModels.length - 3} more` : "";
			lines.push(`  Model: ${theme.fg("info", modelsStr)}${theme.dim(theme.fg("muted", suffix))}`);
		} else {
			lines.push(`  Model: ${theme.dim(theme.fg("muted", "(session default)"))}`);
		}

		// Prewalk
		if (def.prewalk) {
			const pwLabel = typeof def.prewalk === "string" ? `prewalk via ${def.prewalk}` : "prewalk enabled";
			const overrideLabel =
				entry.runtimePrewalkOverride !== undefined
					? entry.runtimePrewalkOverride
						? " (override: on)"
						: " (override: off)"
					: "";
			lines.push(`  ${theme.fg("info", pwLabel)}${theme.dim(theme.fg("muted", overrideLabel))}`);
		}

		// File path
		if (def.filePath) {
			lines.push(`  ${theme.dim(theme.fg("muted", def.filePath))}`);
		}

		// System prompt preview
		lines.push("");
		lines.push(theme.fg("border", ` ${theme.bold("System Prompt")}`));
		lines.push(theme.fg("border", ` ${theme.alpha.char.repeat(Math.min(width - 2, 40))}`));

		const promptLines = def.systemPrompt.split("\n").slice(0, 6);
		for (const pl of promptLines) {
			lines.push(
				`  ${theme.dim(theme.fg("muted", pl.length > width - 4 ? `${pl.slice(0, width - 7)}\u2026` : pl))}`,
			);
		}
		if (def.systemPrompt.split("\n").length > 6) {
			lines.push(`  ${theme.dim(theme.fg("muted", "\u2026 (truncated)"))}`);
		}

		return lines;
	}
}
