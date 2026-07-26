/**
 * MusePi /setup — provider sign-in + web search setup.
 *
 * Flat line-array rendering (no Container/Text yoga positioning) to avoid
 * whitespace and alignment issues. Each rebuild produces a `lines` array
 * from centering/logic alone; render() wraps them in overlay-box chrome.
 */

import { type Component, getKeybindings, type SelectItem, truncateToWidth, visibleWidth } from "@musepi/pi-tui";
import { VERSION } from "../../../config.ts";
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

/** Web search provider options (hardcoded until a proper tool infra lands). */
const SEARCH_PROVIDER_ITEMS: SelectItem[] = [
	{ value: "brave", label: "Brave Search", description: "Free tier available — API key from api.search.brave.com" },
	{ value: "google", label: "Google Custom Search", description: "Requires CX + API key from Google Cloud Console" },
	{ value: "bing", label: "Bing Search", description: "Azure Bing Search API key" },
	{ value: "duckduckgo", label: "DuckDuckGo", description: "No API key needed — rate-limited" },
];

/**
 * Renders a provider list selection box using box-drawing characters.
 * @param items — filtered provider items to display
 * @param selectedIndex — current selection
 * @param searchQuery — current search input (empty = no search bar)
 * @param showScrollPos — whether to show the "(N/M)" scroll indicator
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

	// Top border
	lines.push(theme.fg("border", `${box.topLeft}${box.horizontal.repeat(boxWidth - 2)}${box.topRight}`));

	// Scroll window
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

	// Scroll position
	if (showScrollPos) {
		lines.push(
			theme.fg("border", `${box.vertical} ${theme.fg("dim", `\u2502 (${selectedIndex + 1}/${items.length})`)}`),
		);
	}

	// Search bar
	if (searchQuery) {
		lines.push(theme.fg("border", `${box.vertical} ${theme.fg("accent", ">")} ${searchQuery}_`));
	} else {
		lines.push(theme.fg("border", `${box.vertical} ${theme.fg("dim", "Type to search")}`));
	}

	// Bottom border
	lines.push(theme.fg("border", `${box.bottomLeft}${box.horizontal.repeat(boxWidth - 2)}${box.bottomRight}`));

	return lines;
}

export class SetupWizardComponent implements Component {
	private tab: TabId = "signin";
	private providers: AuthSelectorProvider[];
	private filteredProviders: AuthSelectorProvider[];
	private selectedIndex = 0;
	private searchQuery = "";
	private readonly onSignIn: (provider: AuthSelectorProvider) => void;
	private readonly onCancel: () => void;
	/** Last rendered widget height, for mouse routing. */

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
			this.selectedIndex = 0;
			return;
		}

		if (kb.matches(keyData, "tui.select.cancel") || keyData === "ctrl+c") {
			this.onCancel();
			return;
		}

		if (this.tab === "signin") {
			this.handleSignInInput(keyData);
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

	render(width: number): string[] {
		const inner: string[] = [];
		const boxInner = Math.max(0, width - 4); // inner width for row-wrapped content

		// ── Logo (centered) ──
		const logoWidth = Math.max(...MUSEPI_LOGO.map((l) => visibleWidth(l)));
		const logoPad = Math.floor((boxInner - 2 - logoWidth) / 2); // indent inside row()
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

		// ── Header ──
		inner.push(theme.fg("muted", theme.bold("Setup step 1 of 1")));
		inner.push(theme.fg("accent", theme.bold("Set up your providers")));
		inner.push(theme.fg("dim", "Sign in and pick a web search provider. Press Esc when you're done."));
		inner.push("");

		// ── Tab bar ──
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

		// ── Content ──
		if (this.tab === "signin") {
			inner.push(...this.renderSignInTab(boxInner));
		} else {
			inner.push(...this.renderWebSearchTab(boxInner));
		}

		// ── Footer separator ──
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
		lines.push(theme.fg("dim", "  Pick a default web search provider."));
		lines.push("");

		const box = theme.boxRound;
		const boxWidth = 72;
		lines.push(theme.fg("border", `${box.topLeft}${box.horizontal.repeat(boxWidth - 2)}${box.topRight}`));

		for (const sp of SEARCH_PROVIDER_ITEMS) {
			const label = theme.fg("text", `  ${sp.label}`);
			const desc = sp.description ? theme.fg("dim", `\u2502 ${sp.description}`) : "";
			lines.push(`${theme.fg("border", box.vertical)} ${label}${desc ? ` ${desc}` : ""}`);
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
