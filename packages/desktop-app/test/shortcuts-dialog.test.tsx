import "./happy-dom-shim"; // MUST be first: component module graphs define HTMLElement subclasses at evaluation time.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ShortcutsDialog } from "../src/components/ShortcutsDialog";
import { bindingLabel, getEntry, SHORTCUTS, setBinding } from "../src/lib/shortcut-registry";

/**
 * Keyboard-shortcuts reference.
 *
 * The contract that matters is coverage-by-construction: every entry in the
 * shortcut registry appears in the dialog, with its EFFECTIVE binding. The
 * failure this defends is the duplicated table — a dialog that lists a
 * binding the user rebound last week, or one that silently omits a shortcut
 * added since the dialog was written. Deriving the rows from the registry makes
 * both impossible; this suite holds it that way.
 *
 * Rendered through a real root because the dialog subscribes to
 * `SHORTCUTS_CHANGED_EVENT` — a static render would not observe a rebind and
 * the live-update contract would go untested.
 */

setLocale("zh-CN");
afterAll(() => {
	setLocale("en-US");
});

beforeEach(() => {
	localStorage.clear();
});

/** DialogFrame portals to document.body (a backdrop-filter ancestor would
 *  hijack its fixed positioning), so assertions read the body.
 *
 *  Teardown must UNMOUNT, not remove the host: the portaled dialog is a
 *  sibling of the host, so dropping the host leaves the previous test's dialog
 *  answering the next test's queries — which reads as every count doubling. */
const mounted: { host: HTMLElement; root: ReturnType<typeof createRoot> }[] = [];
async function render(): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	mounted.push({ host, root });
	await act(async () => {
		root.render(createElement(ShortcutsDialog, { open: true, onClose: () => {} }));
	});
	await act(async () => {
		await Promise.resolve();
	});
	return document.body;
}

afterEach(() => {
	for (const { host, root } of mounted.splice(0)) {
		act(() => {
			root.unmount();
		});
		host.remove();
	}
});
describe("ShortcutsDialog", () => {
	test("lists every registry entry — the dialog derives, it is not a table", async () => {
		const host = await render();
		const rows = host.querySelectorAll(".gui-shortcut-row");
		expect(rows.length).toBe(SHORTCUTS.length);
		for (const entry of SHORTCUTS) {
			expect(host.textContent).toContain(entry.id === "stop" ? "Esc" : bindingLabel(entry.id));
		}
	});

	test("renders a heading per registry group", async () => {
		const host = await render();
		const headings = [...host.querySelectorAll(".gui-shortcut-group")].map(h => h.textContent);
		const groupKeys = [...new Set(SHORTCUTS.map(s => s.groupKey).filter(Boolean))];
		// Five groups in the registry, so five headings — no group may be
		// dropped because the dialog's layout only knew about the original set.
		expect(headings.length).toBe(groupKeys.length);
		for (const heading of headings) expect(heading?.length).toBeGreaterThan(0);
	});

	test("shows the EFFECTIVE binding, and follows a rebind while open", async () => {
		const host = await render();
		const before = host.querySelector(".gui-shortcut-row .gui-shortcut-key")?.textContent;
		expect(before).toBeTruthy();
		// Rebind with the registry, not by faking the event: the dialog's job is
		// to re-read the registry when told, so the test drives the same path a
		// user in Settings → 快捷键 does.
		await act(async () => {
			const result = setBinding("new-task", "⌘⇧J");
			expect(result.ok).toBe(true);
		});
		await act(async () => {
			await Promise.resolve();
		});
		const keys = [...host.querySelectorAll(".gui-shortcut-key")].map(k => k.textContent);
		expect(keys).toContain(bindingLabel("new-task"));
		expect(keys.some(k => k !== before)).toBe(true);
	});

	test("an unassigned entry keeps its default rather than going blank", async () => {
		const host = await render();
		for (const entry of SHORTCUTS) {
			const keys = [...host.querySelectorAll(".gui-shortcut-key")].map(k => k.textContent);
			expect(keys).toContain(entry.id === "stop" ? "Esc" : bindingLabel(entry.id));
		}
	});

	test("renders both columns and the tips", async () => {
		const host = await render();
		// The tips ride the tail of a column (openchamber parity): a full-width
		// block below both columns would leave a gap under the longer one.
		expect(host.querySelectorAll(".gui-shortcut-tips li").length).toBeGreaterThan(0);
		expect(host.querySelectorAll(".gui-shortcuts-grid > div").length).toBe(2);
	});

	test("labels the dialog for assistive tech", async () => {
		const host = await render();
		const dialog = host.querySelector('[role="dialog"]');
		expect(dialog).not.toBeNull();
		expect(dialog?.getAttribute("aria-label")).toBeTruthy();
	});

	test("the fixed Esc entry renders as a word, not a glyph", async () => {
		// ⎋ is the canonical binding; ⎋ alone in a <kbd> reads as a box glyph on
		// Windows/Linux, where the key is labelled "Esc".
		expect(getEntry("stop")).toBeDefined();
		expect(bindingLabel("stop")).toBe("Esc");
		const host = await render();
		const keys = [...host.querySelectorAll(".gui-shortcut-key")].map(k => k.textContent);
		expect(keys).toContain("Esc");
		expect(keys.some(k => k?.includes("⎋"))).toBe(false);
	});
});
