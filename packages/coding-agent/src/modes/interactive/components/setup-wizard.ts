/**
 * MusePi /setup — provider sign-in + web search setup.
 *
 * Flat line-array rendering (no Container/Text yoga positioning) to avoid
 * whitespace and alignment issues. Uses SEARCH_PROVIDER_OPTIONS from the
 * web/search module for the interactive provider picker.
 */

import {
	type Component,
	getKeybindings,
	type MouseRoutable,
	type SgrMouseEvent,
	truncateToWidth,
	visibleWidth,
} from "@musepi/pi-tui";
import { VERSION } from "../../../config.ts";
import {
	SEARCH_PROVIDER_OPTIONS,
	type SearchProviderId,
	setPreferredSearchProvider,
} from "../../../web/search/index.ts";
import { theme } from "../theme/theme.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";
import type { AuthSelectorProvider } from "./oauth-selector.ts";
import { bottomBorder, row, topBorder } from "./overlay-box.ts";

type TabId = "signin" | "websearch";

const MUSEPI_LOGO = [
	"    __  ___     ",
	"   |  \\/  |    ",
	"   | .  . |___ ",
	"   | |\\/| / __|",
	"   | |  | \\__ \\",
	"   |_|  |_|___/",
];

const MAX_VISIBLE = 10;

/**
 * Renders a provider list selection box using box-drawing characters.
 */
function renderProviderBox(
	items: AuthSelectorProvider[],
	selectedIndex: number,
	searchQuery: string,
	showScrollPos: boolean,
): string[] {
	if (items.length === 0) return [];

	const box = theme.boxRound;
	const boxWidth = 72;
	const lines: string[] = [];

	lines.push(theme.fg("border", `${box.topLeft}${box.horizontal.repeat(boxWidth - 2)}${box.topRight}`));

	const startIdx = Math.max(0, Math.min(selectedIndex - Math.floor(MAX_VISIBLE / 2), items.length - MAX_VISIBLE));
	const endIdx = Math.min(startIdx + MAX_VISIBLE, items.length);

	for (let i = startIdx; i < endIdx; i++) {
		const p = items[i];
		if (!p) continue;
		const sel = i === selectedIndex;
		const prefix = sel ? theme.fg("accent", ">") : " ";
		const name = sel ? theme.fg("accent", p.name) : theme.fg("text", p.name);
		const typeLabel = p.authType === "oauth" ? "subscription" : "API key";
		const badge = theme.fg("dim", `(${typeLabel})`);
		const checkmark = p.status ? theme.fg("success", " \u2713") : "";
		const content = `${theme.fg("border", box.vertical)} ${prefix} ${name} ${badge}${checkmark}`;
		lines.push(truncateToWidth(content, boxWidth));
	}

	if (showScrollPos) {
		lines.push(
			theme.fg("border", `${box.vertical} ${theme.fg("dim", `\u2502 (${selectedIndex + 1}/${items.length})`)}`),
		);
	}

	if (searchQuery) {
		lines.push(theme.fg("border", `${box.vertical} ${theme.fg("accent", ">")} ${searchQuery}_`));
	} else {
		lines.push(theme.fg("border", `${box.vertical} ${theme.fg("dim", "Type to search")}`));
	}

	lines.push(theme.fg("border", `${box.bottomLeft}${box.horizontal.repeat(boxWidth - 2)}${box.bottomRight}`));

	return lines;
}

export class SetupWizardComponent implements Component, MouseRoutable {
	private tab: TabId = "signin";
	private providers: AuthSelectorProvider[];
	private filteredProviders: AuthSelectorProvider[];
	private selectedIndex = 0;
	private searchQuery = "";
	private webSearchIndex = 0;
	private selectedProvider: string | null = null;
	private readonly onSignIn: (provider: AuthSelectorProvider) => void;
	private readonly onCancel: () => void;
	/** Screen row where the content area starts (for mouse hit-test). */
	private contentRowStart = 0;

	constructor(
		providers: AuthSelectorProvider[],
		onSignIn: (provider: AuthSelectorProvider) => void,
		onCancel: () => void,
	) {
		this.providers = providers;
		this.filteredProviders = [...providers];
		this.onSignIn = onSignIn;
		this.onCancel = onCancel;
	}

	invalidate(): void {
		// no-op — render is stateless up to the component fields
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();

		if (kb.matches(keyData, "tui.input.tab")) {
			this.tab = this.tab === "signin" ? "websearch" : "signin";
			this.webSearchIndex = 0;
			this.selectedIndex = 0;
			return;
		}

		if (kb.matches(keyData, "tui.select.cancel") || keyData === "ctrl+c") {
			this.onCancel();
			return;
		}

		if (this.tab === "signin") {
			this.handleSignInInput(keyData);
		} else {
			this.handleWebSearchInput(keyData);
		}
	}

	private handleSignInInput(keyData: string): void {
		const list = this.filteredProviders.length > 0 ? this.filteredProviders : this.providers;
		const kb = getKeybindings();

		if (kb.matches(keyData, "tui.select.up")) {
			if (list.length === 0) return;
			this.selectedIndex = this.selectedIndex <= 0 ? list.length - 1 : this.selectedIndex - 1;
			return;
		}

		if (kb.matches(keyData, "tui.select.down")) {
			if (list.length === 0) return;
			this.selectedIndex = this.selectedIndex >= list.length - 1 ? 0 : this.selectedIndex + 1;
			return;
		}

		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const p = list[this.selectedIndex];
			if (p) {
				this.onSignIn(p);
			}
			return;
		}

		if (keyData === "backspace") {
			if (this.searchQuery.length > 0) {
				this.searchQuery = this.searchQuery.slice(0, -1);
				this.filterProviders();
			}
			return;
		}

		if (keyData.length === 1 && keyData >= " " && keyData <= "~") {
			this.searchQuery += keyData;
			this.filterProviders();
		}
	}

	private filterProviders(): void {
		if (!this.searchQuery) {
			this.filteredProviders = [...this.providers];
			this.selectedIndex = 0;
			return;
		}
		const q = this.searchQuery.toLowerCase();
		this.filteredProviders = this.providers.filter(
			(p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q),
		);
		this.selectedIndex = 0;
	}

	private handleWebSearchInput(keyData: string): void {
		const items = SEARCH_PROVIDER_OPTIONS;
		const kb = getKeybindings();

		if (kb.matches(keyData, "tui.select.up")) {
			this.webSearchIndex = this.webSearchIndex <= 0 ? items.length - 1 : this.webSearchIndex - 1;
			return;
		}

		if (kb.matches(keyData, "tui.select.down")) {
			this.webSearchIndex = this.webSearchIndex >= items.length - 1 ? 0 : this.webSearchIndex + 1;
			return;
		}

		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const item = items[this.webSearchIndex];
			if (item) {
				const togglingOn = this.selectedProvider !== item.value;
				this.selectedProvider = togglingOn ? item.value : null;
				if (togglingOn) {
					setPreferredSearchProvider(item.value as SearchProviderId);
				}
			}
			return;
		}
	}

	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		// Wheel: scroll provider list (sign-in tab) or websearch list
		if (event.wheel !== null) {
			if (this.tab === "signin") {
				const list = this.filteredProviders.length > 0 ? this.filteredProviders : this.providers;
				if (list.length === 0) return;
				const dir = event.wheel === -1 ? -1 : 1; // wheel up = previous
				this.selectedIndex = (this.selectedIndex + dir + list.length) % list.length;
			} else {
				const items = SEARCH_PROVIDER_OPTIONS;
				const dir = event.wheel === -1 ? -1 : 1;
				this.webSearchIndex = (this.webSearchIndex + dir + items.length) % items.length;
			}
			return;
		}

		// Left click on an item: forward to confirm or navigate
		if (event.leftClick) {
			const relLine = line - this.contentRowStart;
			if (relLine < 0) return; // above content area

			if (this.tab === "signin") {
				const list = this.filteredProviders.length > 0 ? this.filteredProviders : this.providers;
				// Content: "Pick a provider..." (1) + blank (1) + box top (1) + items (N) + scroll/search/bottom
				const itemLine = relLine - 3; // skip info, blank, box top
				if (itemLine >= 0 && itemLine < Math.min(MAX_VISIBLE, list.length)) {
					const startIdx = Math.max(
						0,
						Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE / 2), list.length - MAX_VISIBLE),
					);
					const idx = startIdx + itemLine;
					if (idx < list.length) {
						this.selectedIndex = idx;
						const p = list[idx];
						if (p) {
							this.onSignIn(p);
						}
					}
				}
			} else {
				const itemLine = relLine - 3; // skip info, blank, box top
				if (itemLine >= 0 && itemLine < SEARCH_PROVIDER_OPTIONS.length) {
					this.webSearchIndex = itemLine;
					const item = SEARCH_PROVIDER_OPTIONS[itemLine];
					if (item) {
						const togglingOn = this.selectedProvider !== item.value;
						this.selectedProvider = togglingOn ? item.value : null;
						if (togglingOn) {
							setPreferredSearchProvider(item.value as SearchProviderId);
						}
					}
				}
			}
		}
	}

	render(width: number): string[] {
		const inner: string[] = [];
		const boxInner = Math.max(0, width - 4);

		// Logo (centered)
		const logoWidth = Math.max(...MUSEPI_LOGO.map((l) => visibleWidth(l)));
		const logoPad = Math.floor((boxInner - 2 - logoWidth) / 2);
		if (logoPad > 0) {
			for (const line of MUSEPI_LOGO) {
				inner.push(`${" ".repeat(logoPad)}${theme.fg("accent", line)}`);
			}
			inner.push(`${" ".repeat(logoPad)}${theme.bold(theme.fg("accent", `  musepi v${VERSION}`))}`);
		} else {
			for (const line of MUSEPI_LOGO) {
				inner.push(`  ${theme.fg("accent", line)}`);
			}
			inner.push(theme.bold(theme.fg("accent", `  musepi v${VERSION}`)));
		}
		inner.push("");

		// Header
		inner.push(theme.fg("muted", theme.bold("Setup step 1 of 1")));
		inner.push(theme.fg("accent", theme.bold("Set up your providers")));
		inner.push(theme.fg("dim", "Sign in and pick a web search provider. Press Esc when you're done."));
		inner.push("");

		// Tab bar
		const tabDefs: Array<{ id: TabId; label: string }> = [
			{ id: "signin", label: "Sign in" },
			{ id: "websearch", label: "Web search" },
		];
		let tabLine = "  Providers: ";
		for (const t of tabDefs) {
			const active = t.id === this.tab;
			const boxChar = active ? "\u2590" : " ";
			const label = active ? theme.fg("accent", theme.bold(` ${t.label} `)) : theme.fg("muted", ` ${t.label} `);
			tabLine += `${boxChar}${label}${boxChar}  `;
		}
		tabLine += theme.fg("dim", "(tab to cycle)");
		inner.push(tabLine);
		inner.push("");

		// Content
		this.contentRowStart = inner.length;
		if (this.tab === "signin") {
			inner.push(...this.renderSignInTab(boxInner));
		} else {
			inner.push(...this.renderWebSearchTab(boxInner));
		}

		// Footer
		const separator = "\u2501".repeat(Math.min(boxInner - 2, 76));
		inner.push("");
		inner.push(theme.fg("muted", separator));
		inner.push(this.getFooterHint());

		// Wrap in overlay-box chrome
		const out: string[] = [];
		out.push(topBorder(width, "Setup"));
		for (const line of inner) out.push(row(line, width));
		out.push(bottomBorder(width));
		return out;
	}

	private renderSignInTab(_innerWidth: number): string[] {
		const list = this.filteredProviders.length > 0 ? this.filteredProviders : this.providers;
		if (list.length === 0) return [theme.fg("dim", "  No providers available.")];

		const lines: string[] = [];
		lines.push(theme.fg("dim", `  Pick a provider to sign in \u2014 you can connect more than one.`));

		const showScrollPos = list.length > MAX_VISIBLE || this.searchQuery.length > 0;
		lines.push(...renderProviderBox(list, this.selectedIndex, this.searchQuery, showScrollPos));

		return lines;
	}

	private renderWebSearchTab(_innerWidth: number): string[] {
		const lines: string[] = [];
		lines.push(theme.fg("dim", "  Pick a default web search provider (Enter to toggle)."));
		lines.push("");

		const box = theme.boxRound;
		const boxWidth = 72;
		lines.push(theme.fg("border", `${box.topLeft}${box.horizontal.repeat(boxWidth - 2)}${box.topRight}`));

		for (let i = 0; i < SEARCH_PROVIDER_OPTIONS.length; i++) {
			const sp = SEARCH_PROVIDER_OPTIONS[i];
			const sel = i === this.webSearchIndex;
			const picked = this.selectedProvider === sp.value;
			const prefix = sel ? theme.fg("accent", ">") : " ";
			const label = sel ? theme.fg("accent", ` ${sp.label}`) : theme.fg("text", ` ${sp.label}`);
			const checkmark = picked ? theme.fg("success", " \u2713") : theme.fg("dim", "   ");
			const desc = sp.description ? theme.fg("dim", `\u2502 ${sp.description}`) : "";
			lines.push(`${theme.fg("border", box.vertical)}${prefix}${label}${checkmark}${desc ? ` ${desc}` : ""}`);
		}

		lines.push(
			theme.fg("border", `${box.vertical} ${theme.fg("dim", "Configure via settings.json or environment")}`),
		);
		lines.push(theme.fg("border", `${box.bottomLeft}${box.horizontal.repeat(boxWidth - 2)}${box.bottomRight}`));

		return lines;
	}

	private getFooterHint(): string {
		return theme.fg(
			"dim",
			`${rawKeyHint("\u2191/\u2193", "select")} \u00b7 ${keyHint("tui.select.confirm", "sign in")} \u00b7 ${keyHint("tui.select.cancel", "skip")} \u00b7 ctrl+c exit setup`,
		);
	}
}
