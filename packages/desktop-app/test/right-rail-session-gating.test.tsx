import "./happy-dom-shim"; // MUST be first: component module graphs touch DOM globals at evaluation time.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getLocaleSnapshot, setLocale, type TranslationKey, t } from "@musepi/client-core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RightRail } from "../src/components/RightRail";
import { SURFACE_HIDDEN_KEY, surfaceById } from "../src/lib/surfaces/registry";

/**
 * The rail is a shell-level destination and stays on screen before a session
 * exists (welcome scene). What it must NOT offer there are the surfaces whose
 * every readout is session-scoped: those would open onto a placeholder page.
 */

const originalLocale = getLocaleSnapshot();
const mounted: Array<{ host: HTMLDivElement; root: Root }> = [];

beforeEach(() => {
	localStorage.removeItem(SURFACE_HIDDEN_KEY);
	setLocale("en-US");
});

afterEach(() => {
	while (mounted.length > 0) {
		const entry = mounted.pop();
		if (!entry) continue;
		act(() => entry.root.unmount());
		entry.host.remove();
	}
	document.body.innerHTML = "";
	localStorage.clear();
	setLocale(originalLocale);
});

function renderRail(sessionId: string | null): HTMLElement {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	mounted.push({ host, root });
	act(() => {
		root.render(
			createElement(RightRail, {
				rpc: null,
				sessionId,
				cwd: "C:\\proj",
				rightPanelOpen: false,
				terminalOpen: false,
				onSelect: () => {},
			}),
		);
	});
	return host;
}

function railLabels(host: HTMLElement): Set<string> {
	const labels = new Set<string>();
	for (const button of host.querySelectorAll<HTMLButtonElement>(".gui-right-rail-group .gui-right-rail-btn")) {
		const label = button.getAttribute("aria-label");
		if (label) labels.add(label);
	}
	return labels;
}

function surfaceLabel(id: string): string {
	return t((surfaceById(id)?.label ?? id) as TranslationKey);
}

describe("right-rail session gating", () => {
	it("offers session-scoped surfaces only while a session exists", () => {
		const withSession = railLabels(renderRail("session-1"));
		expect(withSession.has(surfaceLabel("context"))).toBe(true);
		expect(withSession.has(surfaceLabel("trajectory"))).toBe(true);
		expect(withSession.has(surfaceLabel("agents"))).toBe(true);

		const welcome = railLabels(renderRail(null));
		expect(welcome.has(surfaceLabel("context"))).toBe(false);
		expect(welcome.has(surfaceLabel("trajectory"))).toBe(false);
		expect(welcome.has(surfaceLabel("agents"))).toBe(false);
	});

	it("keeps workspace surfaces on the welcome scene", () => {
		const welcome = railLabels(renderRail(null));
		// `files` is contributed by the file-workspace plugin tab, not the
		// registry, so this harness only sees the built-in workspace views.
		for (const id of ["git", "notes", "browser"]) {
			expect(welcome.has(surfaceLabel(id))).toBe(true);
		}
	});
});
