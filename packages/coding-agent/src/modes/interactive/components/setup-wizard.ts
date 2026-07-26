/**
 * MusePi /setup — provider sign-in + web search setup.
 *
 * Branded single-step screen matching OMP's setup UX:
 *   - MusePi ASCII logo + version
 *   - "Set up your providers" header
 *   - Sign in / Web search tab toggle
 *   - Provider picker list with auth-status indicators
 *   - overlay-box framing
 */

import { Container, getKeybindings, Spacer, Text } from "@musepi/pi-tui";
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

const SEARCH_PROVIDERS = ["Brave Search", "Google Custom Search", "Bing Search", "DuckDuckGo"];

export class SetupWizardComponent extends Container {
	private tab: TabId = "signin";
	private providers: AuthSelectorProvider[];
	private filteredProviders: AuthSelectorProvider[];
	private selectedIndex = 0;
	private searchQuery = "";
	private readonly onSignIn: (provider: AuthSelectorProvider) => void;
	private readonly onCancel: () => void;

	constructor(
		providers: AuthSelectorProvider[],
		onSignIn: (provider: AuthSelectorProvider) => void,
		onCancel: () => void,
	) {
		super();
		this.providers = providers;
		this.filteredProviders = [...providers];
		this.onSignIn = onSignIn;
		this.onCancel = onCancel;
		this.rebuild();
	}

	// ═══════════════════════════════════════════════════════════════════════
	//  Rebuild
	// ═══════════════════════════════════════════════════════════════════════

	private rebuild(): void {
		this.clear();

		this.renderLogo();
		this.addChild(new Spacer(1));

		// Header
		this.addChild(new Text(theme.fg("muted", theme.bold("Setup step 1 of 1")), 2, 0));
		this.addChild(new Text(theme.fg("accent", theme.bold("Set up your providers")), 2, 0));
		this.addChild(
			new Text(theme.fg("dim", "Sign in and pick a web search provider. Press Esc when you're done."), 2, 0),
		);
		this.addChild(new Spacer(1));

		this.renderTabs();
		this.addChild(new Spacer(1));

		if (this.tab === "signin") {
			this.renderSignInTab();
		} else {
			this.renderWebSearchTab();
		}

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "\u2501".repeat(76)), 2, 0));
		this.addChild(new Text(this.getFooterHint(), 2, 0));
	}

	private renderLogo(): void {
		for (const line of MUSEPI_LOGO) {
			this.addChild(new Text(theme.fg("accent", line), 30, 0));
		}
		this.addChild(new Text(theme.bold(theme.fg("accent", `  musepi v${VERSION}`)), 31, 0));
	}

	private renderTabs(): void {
		const tabDefs: Array<{ id: TabId; label: string }> = [
			{ id: "signin", label: "Sign in" },
			{ id: "websearch", label: "Web search" },
		];

		let line = "  Providers: ";
		for (const t of tabDefs) {
			const active = t.id === this.tab;
			const boxChar = active ? "\u2590" : " ";
			const label = active ? theme.fg("accent", theme.bold(` ${t.label} `)) : theme.fg("muted", ` ${t.label} `);
			line += `${boxChar}${label}${boxChar}  `;
		}
		line += theme.fg("dim", "(tab to cycle)");
		this.addChild(new Text(line, 0, 0));
	}

	private renderSignInTab(): void {
		const list = this.filteredProviders.length > 0 ? this.filteredProviders : this.providers;
		this.addChild(
			new Text(theme.fg("dim", "Pick a provider to sign in \u2014 you can connect more than one."), 2, 0),
		);
		this.addChild(new Spacer(1));

		const boxWidth = 72;
		const maxVisible = 10;

		this.addChild(new Text(`  ${"\u250C".padEnd(boxWidth - 1, "\u2500")}\u2510`, 0, 0));

		if (this.selectedIndex >= list.length) {
			this.selectedIndex = Math.max(0, list.length - 1);
		}

		const startIdx = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), list.length - maxVisible));
		const endIdx = Math.min(startIdx + maxVisible, list.length);

		for (let i = startIdx; i < endIdx; i++) {
			const p = list[i];
			if (!p) continue;
			const sel = i === this.selectedIndex;
			const prefix = sel ? theme.fg("accent", ">") : " ";
			const name = sel ? theme.fg("accent", p.name) : theme.fg("text", p.name);
			const typeLabel = p.authType === "oauth" ? "subscription" : "API key";
			const badge = theme.fg("dim", `(${typeLabel})`);
			const checkmark = p.status ? theme.fg("success", " \u2713") : "";
			this.addChild(new Text(`  \u2502 ${prefix} ${name} ${badge}${checkmark}`, 0, 0));
		}

		if (list.length > maxVisible || this.searchQuery) {
			this.addChild(new Text(`  \u2502 ${theme.fg("dim", `(${this.selectedIndex + 1}/${list.length})`)}`, 0, 0));
		}

		if (this.searchQuery) {
			this.addChild(new Text(`  \u2502 ${theme.fg("accent", ">")} ${this.searchQuery}_`, 0, 0));
		} else {
			this.addChild(new Text(`  \u2502 ${theme.fg("dim", "Type to search")}`, 0, 0));
		}

		this.addChild(new Text(`  ${"\u2514".padEnd(boxWidth - 1, "\u2500")}\u2518`, 0, 0));
	}

	private renderWebSearchTab(): void {
		this.addChild(new Text(theme.fg("dim", "Pick a default web search provider."), 2, 0));
		this.addChild(new Spacer(1));

		const boxWidth = 72;
		this.addChild(new Text(`  ${"\u250C".padEnd(boxWidth - 1, "\u2500")}\u2510`, 0, 0));

		for (const sp of SEARCH_PROVIDERS) {
			this.addChild(new Text(`  \u2502   ${sp}`, 0, 0));
		}

		this.addChild(new Text(`  \u2502 ${theme.fg("dim", "  Configure via .pi/settings.json or environment")}`, 0, 0));
		this.addChild(new Text(`  ${"\u2514".padEnd(boxWidth - 1, "\u2500")}\u2518`, 0, 0));
	}

	private getFooterHint(): string {
		return theme.fg(
			"dim",
			`${rawKeyHint("\u2191/\u2193", "select")} \u00b7 ${keyHint("tui.select.confirm", "sign in")} \u00b7 ${keyHint("tui.select.cancel", "skip")} \u00b7 ctrl+c exit setup`,
		);
	}

	// ═══════════════════════════════════════════════════════════════════════
	//  Input
	// ═══════════════════════════════════════════════════════════════════════

	handleInput(keyData: string): void {
		const kb = getKeybindings();

		if (kb.matches(keyData, "tui.input.tab")) {
			this.tab = this.tab === "signin" ? "websearch" : "signin";
			this.selectedIndex = 0;
			this.rebuild();
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
			this.rebuild();
			return;
		}

		if (kb.matches(keyData, "tui.select.down")) {
			if (list.length === 0) return;
			this.selectedIndex = this.selectedIndex >= list.length - 1 ? 0 : this.selectedIndex + 1;
			this.rebuild();
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
				this.rebuild();
			}
			return;
		}

		if (keyData.length === 1 && keyData >= " " && keyData <= "~") {
			this.searchQuery += keyData;
			this.filterProviders();
			this.rebuild();
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

	// ── Render (overlay-box framing) ────────────────────────────────

	override render(width: number): string[] {
		const out: string[] = [];
		out.push(topBorder(width, "Setup"));

		const inner = super.render(width - 4);
		for (const line of inner) out.push(row(line, width));

		out.push(bottomBorder(width));
		return out;
	}
}
