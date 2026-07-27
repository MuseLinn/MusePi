/**
 * Dual-pane model selector — both panes always visible (OMP-aligned).
 *
 * Layout: provider sidebar on the left, model list on the right, separated
 * by a vertical bar. Details and footer below.
 *
 *   ┌─ overlay-box ────────────────────────────────────────────────────┐
 *   │  Scope: all | scoped   Tab to toggle                              │
 *   │  Search: [_____________________________]                          │
 *   ├───────────────────────────────────────────────────────────────────┤
 *   │  Providers        │  Models                                       │
 *   │  ● all            │  → deepseek-v4-flash    1M     $0.14/0.28 ✓  │
 *   │  ● recent         │    kimi-k2.7-code       262k   $0.95/4.0     │
 *   │  ────────────     │    deepseek-v4-pro       1M    $0.41/0.61    │
 *   │  ○ ollama         │    ...                                        │
 *   │  ● anthropic      │                                               │
 *   ├───────────────────┴───────────────────────────────────────────────┤
 *   │  provider/id  DeepSeek V4 Flash · 1M ctx · 384k out · $X/Y/M     │
 *   │  ← → switch pane · ↑/↓ select · Enter confirm · Esc cancel       │
 *   └───────────────────────────────────────────────────────────────────┘
 */

import { type Model, modelsAreEqual } from "@musepi/pi-ai";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	type SgrMouseEvent,
	Spacer,
	Text,
	type TUI,
} from "@musepi/pi-tui";
import type { ModelRuntime } from "../../../core/model-runtime.ts";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import { getModelSelectorSearchText } from "../model-search.ts";
import { theme } from "../theme/theme.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";
import { bottomBorder, row, topBorder } from "./overlay-box.ts";

interface ModelItem {
	provider: string;
	id: string;
	model: Model<any>;
}

interface ScopedModelItem {
	model: Model<any>;
	thinkingLevel?: string;
}

interface ProviderEntry {
	id: string;
	count: number;
	active: boolean;
}

type ModelScope = "all" | "scoped";
type FocusPane = "providers" | "models";

/** `$in/out` per-million cost pair; `free` when both legs are zero or absent. */
function formatCostPair(model: Model<any>): string {
	const cost = model.cost;
	if (!cost || (cost.input <= 0 && cost.output <= 0)) return "free";
	const fmt = (n: number): string => {
		if (n <= 0) return "0";
		const s = n >= 100 ? String(Math.round(n)) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
		return s.replace(/\.?0+$/, "");
	};
	return `$${fmt(cost.input)}/${fmt(cost.output)}`;
}

/** `1M`, `128k`, `400k`, etc. */
function formatNumber(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(n);
}

/** Context column text; empty when model doesn't report one. */
function formatContext(model: Model<any>): string {
	const ctx = model.contextWindow ?? 0;
	return ctx <= 0 ? "" : formatNumber(ctx);
}

/** Pad `text` left to `width`. */
function padLeft(text: string, width: number): string {
	const m = width - text.length;
	return m > 0 ? " ".repeat(m) + text : text;
}

/** Pad `text` right to `width`. */
function padRight(text: string, width: number): string {
	return text.length >= width ? text : text + " ".repeat(width - text.length);
}

export class ModelSelectorComponent extends Container implements Focusable {
	private searchInput: Input;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	private allModels: ModelItem[] = [];
	private scopedModelItems: ModelItem[] = [];
	private activeModels: ModelItem[] = [];
	private filteredModels: ModelItem[] = [];
	private selectedModelIndex = 0;
	private currentModel?: Model<any>;
	private settingsManager: SettingsManager;
	private modelRuntime: ModelRuntime;
	private onSelectCallback: (model: Model<any>) => void;
	private onCancelCallback: () => void;
	private errorMessage?: string;
	private refreshStatusMessage = "Refreshing model catalogs\u2026";
	private refreshStatusSuccess = false;
	private tui: TUI;
	private scopedModels: ReadonlyArray<ScopedModelItem>;
	private scope: ModelScope = "all";
	private scopeText?: Text;
	private readonly refreshAbortController = new AbortController();
	private refreshTimeout?: ReturnType<typeof setTimeout>;
	private closed = false;

	// Dual-pane state
	private focusPane: FocusPane = "providers";
	private providers: ProviderEntry[] = [];
	private selectedProviderIndex = 0;
	private readonly SIDEBAR_WIDTH = 20;
	private ctxWidth = 8;
	private costWidth = 10;

	// Mouse geometry (updated on every render)
	private paneRowStart = 0;
	private paneRowCount = 0;

	constructor(
		tui: TUI,
		currentModel: Model<any> | undefined,
		settingsManager: SettingsManager,
		modelRuntime: ModelRuntime,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (model: Model<any>) => void,
		onCancel: () => void,
		initialSearchInput?: string,
	) {
		super();

		this.tui = tui;
		this.currentModel = currentModel;
		this.settingsManager = settingsManager;
		this.modelRuntime = modelRuntime;
		this.scopedModels = scopedModels;
		this.scope = scopedModels.length > 0 ? "scoped" : "all";
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		this.addChild(new Spacer(1));

		this.scopeText = this.buildScopeLine();
		this.addChild(this.scopeText);
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		if (initialSearchInput) this.searchInput.setValue(initialSearchInput);
		this.searchInput.onSubmit = () => {
			const m = this.filteredModels[this.selectedModelIndex];
			if (m) this.handleSelect(m.model);
		};
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		this.loadModelsFromSnapshot();
		if (initialSearchInput) this.filterModels(initialSearchInput);
		this.rebuildPane();
		this.tui.requestRender();
		void this.refreshModels();
	}

	private buildScopeLine(): Text {
		if (this.scopedModels.length > 0) {
			const a = this.scope === "all" ? theme.fg("accent", "all") : theme.fg("muted", "all");
			const s = this.scope === "scoped" ? theme.fg("accent", "scoped") : theme.fg("muted", "scoped");
			return new Text(
				`${theme.fg("muted", "Scope: ")}${a}${theme.fg("muted", " | ")}${s}  ${keyHint("tui.input.tab", "toggle")}`,
				0,
				0,
			);
		}
		return new Text(
			theme.fg("warning", "Only showing models from configured providers. Use /login to add providers."),
			0,
			0,
		);
	}

	private loadModelsFromSnapshot(): void {
		const models = this.modelRuntime.getAvailableSnapshot().map((model: Model<any>) => ({
			provider: model.provider,
			id: model.id,
			model,
		}));
		this.allModels = this.sortModels(models);
		this.scopedModels = this.scopedModels.map((s) => {
			const r = this.modelRuntime.getModel(s.model.provider, s.model.id);
			return r ? { ...s, model: r } : s;
		});
		this.scopedModelItems = this.scopedModels.map((s) => ({
			provider: s.model.provider,
			id: s.model.id,
			model: s.model,
		}));
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		this.filteredModels = this.activeModels;
		this.rebuildProviderList();
		const ci = this.filteredModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		this.selectedModelIndex =
			ci >= 0 ? ci : Math.min(this.selectedModelIndex, Math.max(0, this.filteredModels.length - 1));
		this.recomputeWidths();
	}

	private recomputeWidths(): void {
		this.ctxWidth = Math.max(6, ...this.filteredModels.map((m) => formatContext(m.model).length));
		this.costWidth = Math.max(10, ...this.filteredModels.map((m) => formatCostPair(m.model).length));
	}

	private async refreshModels(): Promise<void> {
		const timeoutMs = 15_000;
		let timedOut = false;
		this.refreshTimeout = setTimeout(() => {
			timedOut = true;
			this.refreshAbortController.abort();
		}, timeoutMs);
		try {
			const result = await this.modelRuntime.refresh({ signal: this.refreshAbortController.signal });
			if (this.closed) return;
			this.refreshStatusMessage = "";
			if (result.aborted && timedOut) {
				this.errorMessage = "Model refresh timed out; showing cached models.";
			} else if (result.errors.size === 1) {
				this.errorMessage = `Could not refresh ${result.errors.keys().next().value}; showing cached models.`;
			} else if (result.errors.size > 1) {
				this.errorMessage = `Could not refresh ${result.errors.size} model catalogs; showing cached models.`;
			} else {
				this.errorMessage = this.modelRuntime.getError();
				if (!this.errorMessage) {
					this.refreshStatusMessage = "Model catalogs refreshed.";
					this.refreshStatusSuccess = true;
				}
			}
			this.loadModelsFromSnapshot();
			this.filterModels(this.searchInput.getValue());
			this.tui.requestRender();
		} finally {
			if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		}
	}

	private close(): void {
		this.closed = true;
		if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		this.refreshAbortController.abort();
	}

	private sortModels(models: ModelItem[]): ModelItem[] {
		return [...models].sort((a, b) => {
			const aC = modelsAreEqual(this.currentModel, a.model);
			const bC = modelsAreEqual(this.currentModel, b.model);
			if (aC && !bC) return -1;
			if (!aC && bC) return 1;
			return a.provider.localeCompare(b.provider);
		});
	}

	private rebuildProviderList(): void {
		const seen = new Map<string, { count: number; active: boolean }>();
		for (const m of this.activeModels) {
			const e = seen.get(m.provider) ?? { count: 0, active: false };
			e.count++;
			if (modelsAreEqual(this.currentModel, m.model)) e.active = true;
			seen.set(m.provider, e);
		}
		const entries = Array.from(seen.entries()).map(([id, info]) => ({ id, count: info.count, active: info.active }));
		this.providers = [
			{
				id: "all",
				count: this.activeModels.length,
				active: this.activeModels.some((m) => modelsAreEqual(this.currentModel, m.model)),
			},
			...entries,
		];
		if (this.selectedProviderIndex >= this.providers.length) this.selectedProviderIndex = 0;
	}
	private setScope(scope: ModelScope): void {
		if (this.scope === scope) return;
		this.scope = scope;
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		const ci = this.activeModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		this.selectedModelIndex = ci >= 0 ? ci : 0;
		this.filterModels(this.searchInput.getValue());
		this.rebuildProviderList();
		this.recomputeWidths();
		if (this.scopeText) {
			this.scopeText = this.buildScopeLine();
		}
		this.rebuildPane();
	}

	// ═══════════════════════════════════════════════════════════════════════
	//  Dual-pane layout — side-by-side every render
	// ═══════════════════════════════════════════════════════════════════════

	private rebuildPane(): void {
		// Keep header section (indices 0-3): Spacer, scopeText, Spacer, searchInput
		const keep = 4;
		while (this.children.length > keep) this.removeChild(this.children[this.children.length - 1]);

		this.addChild(new Spacer(1));

		const sideLines = this.renderSidebar();
		const bodyLines = this.renderBody();
		const maxRows = Math.max(sideLines.length, bodyLines.length);

		for (let i = 0; i < maxRows; i++) {
			const left = sideLines[i] ?? "";
			const right = bodyLines[i] ?? "";
			const sepCh = theme.fg("dim", " \u2502 ");
			this.addChild(new Text(` ${padRight(left, this.SIDEBAR_WIDTH)}${sepCh}${right}`, 0, 0));
		}

		this.addChild(new Spacer(1));
		this.renderDetail();

		if (this.errorMessage) {
			for (const l of this.errorMessage.split("\n")) this.addChild(new Text(theme.fg("error", `  ${l}`), 0, 0));
		}
		if (this.refreshStatusMessage) {
			this.addChild(
				new Text(theme.fg(this.refreshStatusSuccess ? "success" : "muted", `  ${this.refreshStatusMessage}`), 0, 0),
			);
		}

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", this.footerText()), 2, 0));
		this.addChild(new Spacer(1));
	}

	private renderSidebar(): string[] {
		const lines: string[] = [];
		const focused = this.focusPane === "providers";
		for (let i = 0; i < this.providers.length; i++) {
			const p = this.providers[i];
			const sel = i === this.selectedProviderIndex && focused;
			const dot = p.active ? theme.fg("success", "\u25CF") : theme.fg("muted", "\u25CB");
			const label = i === 0 ? "All models" : p.id;
			const text = sel ? theme.fg("accent", label) : theme.fg("text", label);
			const prefix = sel ? theme.fg("accent", "\u25B6 ") : "  ";
			lines.push(`${prefix}${dot} ${text}${theme.fg("dim", ` ${p.count}`)}`);
		}
		if (this.providers.length === 0) lines.push(theme.fg("muted", "  No providers"));
		return lines;
	}

	private renderBody(): string[] {
		const list = this.filteredModels;
		if (list.length === 0) return [theme.fg("muted", "No matching models")];

		if (this.selectedModelIndex >= list.length) this.selectedModelIndex = Math.max(0, list.length - 1);

		const focused = this.focusPane === "models";
		const maxVis = 15;
		const start = Math.max(0, Math.min(this.selectedModelIndex - 7, list.length - maxVis));
		const end = Math.min(start + maxVis, list.length);
		const lines: string[] = [];

		for (let i = start; i < end; i++) {
			const item = list[i];
			if (!item) continue;
			const sel = i === this.selectedModelIndex && focused;
			const cur = modelsAreEqual(this.currentModel, item.model);
			const prefix = sel ? theme.fg("accent", "\u25B6 ") : "  ";
			const mid = sel ? theme.fg("accent", item.id) : theme.fg("text", item.id);
			const ck = cur ? theme.fg("success", " \u2713") : "";
			const ctx = formatContext(item.model);
			const cc = ctx ? theme.fg("dim", padLeft(ctx, this.ctxWidth)) : " ".repeat(this.ctxWidth);
			const costCol = theme.fg("dim", padLeft(formatCostPair(item.model), this.costWidth));
			lines.push(`${prefix}${mid}${ck}  ${cc}  ${costCol}`);
		}

		if (start > 0 || end < list.length) {
			lines.push(theme.fg("dim", `  (${this.selectedModelIndex + 1}/${list.length})`));
		}
		return lines;
	}

	private renderDetail(): void {
		const m = this.filteredModels[this.selectedModelIndex]?.model;
		if (!m) return;
		const parts: string[] = [theme.bold(m.name)];
		if (m.contextWindow) parts.push(`${formatNumber(m.contextWindow)} ctx`);
		if (m.maxTokens) parts.push(`${formatNumber(m.maxTokens)} out`);
		const c = m.cost;
		if (c && (c.input > 0 || c.output > 0)) parts.push(`$${c.input}/${c.output}/M`);
		if (m.reasoning) parts.push("reasoning");
		this.addChild(
			new Text(`  ${theme.fg("dim", `${m.provider}/${m.id}`)}  ${theme.fg("accent", parts.join(" \u00B7 "))}`, 0, 0),
		);
	}

	private footerText(): string {
		if (this.focusPane === "providers") {
			return `${rawKeyHint("\u2191/\u2193", "provider list")} \u00B7 ${rawKeyHint("\u2192", "model list")} \u00B7 ${keyHint("tui.select.confirm", "filter")} \u00B7 Esc cancel`;
		}
		return `${rawKeyHint("\u2191/\u2193", "model list")} \u00B7 ${rawKeyHint("\u2190", "provider list")} \u00B7 ${keyHint("tui.select.confirm", "select")} \u00B7 Esc cancel`;
	}

	// ═══════════════════════════════════════════════════════════════════════
	//  Input
	// ═══════════════════════════════════════════════════════════════════════

	handleInput(keyData: string): void {
		const kb = getKeybindings();

		if (kb.matches(keyData, "tui.input.tab")) {
			if (this.scopedModelItems.length > 0) this.setScope(this.scope === "all" ? "scoped" : "all");
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.close();
			this.onCancelCallback();
			return;
		}

		if (keyData === "left" && this.focusPane === "models") {
			this.focusPane = "providers";
			this.rebuildPane();
			return;
		}
		if (keyData === "right" && this.focusPane === "providers") {
			this.focusPane = "models";
			this.selectedModelIndex = 0;
			this.rebuildPane();
			return;
		}

		if (this.focusPane === "providers") this.handleProviderInput(keyData);
		else this.handleModelInput(keyData);
	}

	private handleProviderInput(keyData: string): void {
		const kb = getKeybindings();

		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			this.applyProviderFilter();
			this.focusPane = "models";
			this.selectedModelIndex = 0;
			this.rebuildPane();
			return;
		}

		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			if (this.providers.length === 0) return;
			this.selectedProviderIndex =
				this.selectedProviderIndex <= 0 ? this.providers.length - 1 : this.selectedProviderIndex - 1;
			this.rebuildPane();
			return;
		}
		if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			if (this.providers.length === 0) return;
			this.selectedProviderIndex =
				this.selectedProviderIndex >= this.providers.length - 1 ? 0 : this.selectedProviderIndex + 1;
			this.rebuildPane();
			return;
		}

		// Forward all other input to the search Input (handles cursor, IME, paste, delete, etc.)
		this.searchInput.handleInput(keyData);
		this.filterModels(this.searchInput.getValue());
		if (this.searchInput.getValue().length > 0) this.focusPane = "models";
		this.rebuildPane();
	}

	private handleModelInput(keyData: string): void {
		const kb = getKeybindings();

		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filteredModels.length === 0) return;
			this.selectedModelIndex =
				this.selectedModelIndex === 0 ? this.filteredModels.length - 1 : this.selectedModelIndex - 1;
			this.rebuildPane();
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredModels.length === 0) return;
			this.selectedModelIndex =
				this.selectedModelIndex === this.filteredModels.length - 1 ? 0 : this.selectedModelIndex + 1;
			this.rebuildPane();
			return;
		}

		if (kb.matches(keyData, "tui.select.confirm")) {
			const m = this.filteredModels[this.selectedModelIndex];
			if (m) this.handleSelect(m.model);
			return;
		}

		// Forward all other input to the search Input (handles cursor, IME, paste, delete, etc.)
		this.searchInput.handleInput(keyData);
		this.filterModels(this.searchInput.getValue());
		this.rebuildPane();
	}

	private applyProviderFilter(): void {
		const p = this.providers[this.selectedProviderIndex]?.id;
		if (!p) return;
		if (p === "all") {
			this.filteredModels = [...this.activeModels];
		} else {
			this.filteredModels = this.activeModels.filter((m) => m.provider === p);
		}
		this.selectedModelIndex = 0;
		this.recomputeWidths();
	}

	private filterModels(query: string): void {
		this.filteredModels = query
			? fuzzyFilter(this.activeModels, query, ({ id, provider, model }) =>
					getModelSelectorSearchText({ id, provider, name: model.name }),
				)
			: this.activeModels;
		this.selectedModelIndex = Math.min(this.selectedModelIndex, Math.max(0, this.filteredModels.length - 1));
		this.recomputeWidths();
	}

	private handleSelect(model: Model<any>): void {
		this.close();
		this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
		this.onSelectCallback(model);
	}

	getSearchInput(): Input {
		return this.searchInput;
	}

	// ── Render (overlay-box framing) ────────────────────────────────

	override render(width: number): string[] {
		const out: string[] = [];
		out.push(topBorder(width, "Models"));

		const inner = super.render(width - 4);
		// Geometry: header is Spacer(1) + scope + Spacer(1) + search + Spacer(1) = 5 rows,
		// then rebuildPane adds another Spacer(1) before the dual-pane rows.
		this.paneRowStart = out.length + 5;
		for (const line of inner) out.push(row(line, width));
		this.paneRowCount = Math.max(0, inner.length - 6 - 4); // subtract header(5)+leading spacer(1)+detail+error/status+footer+trailing spacer

		out.push(bottomBorder(width));
		return out;
	}

	// ── Mouse support ──────────────────────────────────────────────

	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		const rel = line - this.paneRowStart;
		if (rel < 0 || rel >= this.paneRowCount) return;

		const providers = this.providers;
		const models = this.filteredModels;
		const providerRow = rel;
		const modelRow = rel;

		if (event.wheel !== null) {
			if (event.wheel > 0) {
				// scroll down
				if (this.selectedProviderIndex < providers.length - 1) this.selectedProviderIndex++;
				else if (this.selectedModelIndex < models.length - 1) this.selectedModelIndex++;
			} else {
				// scroll up
				if (this.selectedProviderIndex > 0) this.selectedProviderIndex--;
				else if (this.selectedModelIndex > 0) this.selectedModelIndex--;
			}
			this.rebuildPane();
			return;
		}

		if (event.leftClick) {
			// Determine which pane was clicked based on column
			// Layout: " " + left(SIDEBAR_WIDTH) + " | " + right...
			const providerEndCol = 1 + this.SIDEBAR_WIDTH; // cols 1..20 (inclusive)
			const separatorEndCol = providerEndCol + 3; // " | "
			const clickedProvider = _col >= 1 && _col <= providerEndCol;
			const clickedModel = _col >= separatorEndCol;

			if (clickedProvider && providerRow < providers.length) {
				this.selectedProviderIndex = providerRow;
				this.applyProviderFilter();
				this.focusPane = "models";
				this.selectedModelIndex = 0;
				this.rebuildPane();
			} else if (clickedModel && modelRow < models.length) {
				this.selectedModelIndex = modelRow;
				this.rebuildPane();
			}
		}
	}
}
