import "./happy-dom-shim";
import { afterEach, describe, expect, test } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InstanceManagerDialog } from "../src/components/InstanceManagerDialog";
import type { RemoteHost } from "../src/lib/remote-hosts";

/**
 * Keyboard, focus order and containment for the two-axis dialog.
 *
 * Escape must close the dialog itself, not an inner panel: the manager is one
 * surface with two sections, so an Escape that only collapsed a section would
 * leave the user pressing it twice for one intent. Focus order follows reading
 * order, which is the order the axes are stated in.
 */

setLocale("zh-CN");

const mounted = new Set<Root>();

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
	delete (globalThis as { musepiShell?: unknown }).musepiShell;
});

const HOSTS: RemoteHost[] = [{ id: "h1", label: "build-box", url: "ws://192.168.1.20:8300" }];

async function render(overrides: Partial<Parameters<typeof InstanceManagerDialog>[0]> = {}): Promise<{
	closes: number;
	host: HTMLElement;
}> {
	const state = { closes: 0 };
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	mounted.add(root);
	await act(async () => {
		root.render(
			<InstanceManagerDialog
				open
				onClose={() => {
					state.closes += 1;
				}}
				rpc={{ request: async () => ({ hosts: [], sshfs: true }) } as never}
				connected
				daemonUrl="ws://127.0.0.1:8300"
				hosts={HOSTS}
				onSwitchHost={() => {}}
				onAddHost={() => {}}
				onRemoveHost={() => {}}
				onDisconnect={() => {}}
				onOpenWorkspace={() => {}}
				onOpenDisclaimer={() => {}}
				{...overrides}
			/>,
		);
		await Bun.sleep(20);
	});
	return { closes: state.closes, host };
}

const dialog = (): HTMLElement => document.body.querySelector(".gui-dialog") as HTMLElement;

describe("keyboard and containment", () => {
	test("Escape closes the dialog rather than an inner panel", async () => {
		let closes = 0;
		await render({
			onClose: () => {
				closes += 1;
			},
		});
		await act(async () => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		expect(closes).toBe(1);
		// Both sections survive the press: nothing collapsed.
		expect(document.body.querySelectorAll(".gui-loc-section")).toHaveLength(2);
	});

	test("focus starts inside the dialog, not on the page behind it", async () => {
		await render();
		expect(dialog().contains(document.activeElement)).toBe(true);
	});

	test("focus order follows reading order: the daemon axis comes first", async () => {
		await render();
		const focusable = Array.from(
			dialog().querySelectorAll<HTMLElement>(
				'button:not([disabled]), input, select, [tabindex]:not([tabindex="-1"])',
			),
		);
		const daemonIndex = focusable.findIndex(
			node => node.closest(".gui-loc-section") === document.body.querySelectorAll(".gui-loc-section")[0],
		);
		const filesIndex = focusable.findIndex(
			node => node.closest(".gui-loc-section") === document.body.querySelectorAll(".gui-loc-section")[1],
		);
		expect(daemonIndex).toBeGreaterThanOrEqual(0);
		expect(filesIndex).toBeGreaterThan(daemonIndex);
	});

	test("a section is reachable by its own heading id", async () => {
		await render();
		// `aria-labelledby` pointing at nothing is the silent a11y regression.
		for (const section of Array.from(document.body.querySelectorAll<HTMLElement>(".gui-loc-section"))) {
			const id = section.getAttribute("aria-labelledby");
			expect(id).not.toBeNull();
			expect(document.getElementById(id as string)).not.toBeNull();
		}
	});

	test("the two sections are siblings, not nested regions", async () => {
		await render();
		const sections = Array.from(document.body.querySelectorAll<HTMLElement>(".gui-loc-section"));
		expect(sections).toHaveLength(2);
		expect(sections[0]?.contains(sections[1] as Node)).toBe(false);
	});

	test("the remove control is keyboard reachable, not hover-only", async () => {
		await render();
		const remove = document.body.querySelector<HTMLButtonElement>(".gui-loc-remove");
		expect(remove).not.toBeNull();
		// Hover reveal without `:focus-visible` is the defect M86 named; the
		// class is styled by both, and the element must be a real button.
		expect(remove?.tagName).toBe("BUTTON");
		expect(remove?.disabled).toBe(false);
	});
});

describe("no nested scroller", () => {
	test("the embedded list does not declare its own scroll box", async () => {
		// Inside the dialog body, a scrolling list would be the nested-scrollbar
		// shape M80's contract forbids.
		await render();
		for (const list of Array.from(document.body.querySelectorAll<HTMLElement>(".gui-loc-list"))) {
			expect(list.classList.contains("gui-loc-list--scroll")).toBe(false);
		}
	});

	test("the dialog body is the one scroller and it declares both axes", async () => {
		await render();
		const body = document.body.querySelector(".gui-instance-manager-body");
		expect(body).not.toBeNull();
		const css = await Bun.file(new URL("../src/styles/gui-chrome.css", import.meta.url)).text();
		const rule = css.slice(css.indexOf(".gui-instance-manager-body {"));
		const block = rule.slice(0, rule.indexOf("}"));
		expect(block).toContain("overflow-y: auto");
		expect(block).toContain("overflow-x: clip");
		expect(block).toContain("overscroll-behavior: contain");
	});

	test("the dialog width rule is declared once", async () => {
		// Two declarations at equal specificity make the winner depend on sheet
		// order — the exact failure the shortcuts dialog recorded.
		const css = await Bun.file(new URL("../src/styles/gui-chrome.css", import.meta.url)).text();
		const matches = css.match(/\.gui-dialog\.gui-dialog--instance-manager\s*\{/g) ?? [];
		expect(matches).toHaveLength(1);
	});
});
