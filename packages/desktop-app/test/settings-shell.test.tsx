import "./happy-dom-shim"; // MUST be first: component module graphs define HTMLElement subclasses at evaluation time.
import { afterAll, describe, expect, test } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SettingsNav } from "../src/components/SettingsNav";
import { computeSettingsShellState } from "../src/lib/settings-shell";

/**
 * Settings-shell slot-replacement contracts (2026-09-24):
 *
 * 1. Slot decision table (computeSettingsShellState): while settings is
 *    open — or inside its 150ms close window — the nav slot is mounted and
 *    the sidebar/chat keepers are display:none; closed means fully restored.
 *    This is the "设置打开时侧栏槽位渲染设置导航、关闭恢复" contract at the
 *    decision point app.tsx renders from. The live click-through it drives
 *    (open → nav click switches content → back restores the sidebar) was
 *    verified via CDP against the built bundle; see the task report.
 * 2. The nav column (SettingsNav) is controlled and slot-agnostic: clicking
 *    a row reports the row's section id through onSelect, and the highlight
 *    follows the activeSection prop — the click→switch chain the settings
 *    pane depends on (lib/settings-nav.ts owns the id contract).
 */

// Nav labels resolve through t(); pin zh-CN so row lookups are deterministic
// (happy-dom's navigator defaults to en-US). Restored so later test files in
// the same process see the default locale.
setLocale("zh-CN");
afterAll(() => {
	setLocale("en-US");
});

describe("computeSettingsShellState", () => {
	test("closed: workspace visible, no slot", () => {
		const s = computeSettingsShellState({ settingsOpen: false, leavingSettings: false });
		expect(s.settingsActive).toBe(false);
		expect(s.navSlotMounted).toBe(false);
		expect(s.sideKeeperHidden).toBe(false);
		expect(s.chatColKeeperHidden).toBe(false);
	});

	test("open: nav slot mounted, sidebar + chat keepers hidden", () => {
		const s = computeSettingsShellState({ settingsOpen: true, leavingSettings: false });
		expect(s.settingsActive).toBe(true);
		expect(s.navSlotMounted).toBe(true);
		expect(s.navSlotLeaving).toBe(false);
		expect(s.sideKeeperHidden).toBe(true);
		expect(s.chatColKeeperHidden).toBe(true);
	});

	test("leaving (close window): slot stays mounted for the blur-out", () => {
		// settingsOpen already flipped false while the 150ms blur-out plays —
		// the shell must NOT unmount early or the fade would clip.
		const s = computeSettingsShellState({ settingsOpen: false, leavingSettings: true });
		expect(s.settingsActive).toBe(true);
		expect(s.navSlotMounted).toBe(true);
		expect(s.navSlotLeaving).toBe(true);
		expect(s.sideKeeperHidden).toBe(true);
		expect(s.chatColKeeperHidden).toBe(true);
	});

	test("closed after leave: identical to never-opened (keepers reveal)", () => {
		const s = computeSettingsShellState({ settingsOpen: false, leavingSettings: false });
		expect(s).toEqual({
			settingsActive: false,
			navSlotMounted: false,
			navSlotLeaving: false,
			sideKeeperHidden: false,
			chatColKeeperHidden: false,
		});
	});
});

describe("SettingsNav interaction", () => {
	const host = document.createElement("div");
	document.body.appendChild(host);
	// One root for the whole describe: re-creating it per test trips React's
	// "container already passed to createRoot()" warning.
	const root = createRoot(host);
	const picked: string[] = [];

	function mount(activeSection: string): HTMLButtonElement[] {
		act(() => {
			root.render(
				createElement(SettingsNav, {
					extTabs: [],
					activeSection,
					onSelect: (id: string) => picked.push(id),
					onBack: () => {},
					query: "",
					onQueryChange: () => {},
				}),
			);
		});
		return Array.from(host.querySelectorAll<HTMLButtonElement>(".gui-settings-nav"));
	}

	test("clicking a row reports its section id (nav click → section request)", () => {
		const rows = mount("appearance");
		// The nav exposes every built-in section row plus the bottom
		// user-area entries (onboarding / what's-new) — all clickable.
		expect(rows.length).toBeGreaterThanOrEqual(28);
		const extensionsRow = rows.find(b => b.querySelector(".gui-settings-nav-label")?.textContent === "扩展");
		expect(extensionsRow).toBeDefined();
		act(() => {
			extensionsRow!.click();
		});
		// "扩展" is the nav label of the `skills` section — the exact path of
		// the reported bug (clicking 扩展 must request skills, whose content
		// branch is the ExtensionsCenter).
		expect(picked).toContain("skills");
	});

	test("the highlight follows the activeSection prop, not click order", () => {
		const rows = mount("model");
		const active = rows.find(b => b.className.includes("gui-settings-nav--active"));
		expect(active?.querySelector(".gui-settings-nav-label")?.textContent).toBe("模型与供应商");
	});
});
