import "./happy-dom-shim"; // MUST be first: component module graphs touch DOM globals at evaluation time.
import { afterEach, describe, expect, it, vi } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ChatView } from "../src/components/ChatView";
import type { RpcClient } from "../src/lib/rpc";

/**
 * Welcome scene (no session) keeps the shell-level right column: the rail is
 * always visible (OpenChamber layout parity) and the panel opens onto its
 * zero-tab page. Session-scoped entries are present there but disabled — the
 * page explains what the panel holds without pretending it can open it.
 */

const rpc = {
	request: async (method: string) => {
		if (method.startsWith("models.list")) return [];
		if (method === "git.branches") return { error: "not a repository" };
		return {};
	},
	addEventListener: () => () => {},
} as unknown as RpcClient;

const originalLocale = getLocaleSnapshot();

afterEach(() => {
	document.body.innerHTML = "";
	localStorage.clear();
	setLocale(originalLocale);
	vi.restoreAllMocks();
});

describe("ChatView welcome scene right column", () => {
	it("renders the rail and the panel empty state without a session", async () => {
		setLocale("en-US");
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);

		await act(async () => {
			root.render(
				<ChatView
					store={null}
					rpc={rpc}
					onSend={() => {}}
					onStop={() => {}}
					onDecideApproval={() => {}}
					busy={false}
					project="C:/workspace"
					onProject={() => {}}
					onSubmitNewSession={() => {}}
					rightPanelOpen
					terminalOpen={false}
					focusMode={false}
					onToggleFocus={() => {}}
					sessionInfoOpen={false}
					onToggleSessionInfo={() => {}}
				/>,
			);
		});

		// The rail belongs to the shell row, not to the chat scene: scenes and
		// rail are siblings, so the rail survives the welcome ⇄ chat swap.
		const rail = host.querySelector(".gui-right-rail");
		const scenes = host.querySelector(".gui-scenes");
		expect(rail).not.toBeNull();
		expect(scenes).not.toBeNull();
		expect(rail?.parentElement).toBe(scenes?.parentElement);

		// Session-scoped launchers are not offered before a session exists.
		const labels = [...host.querySelectorAll(".gui-right-rail-btn")].map(b => b.getAttribute("aria-label"));
		expect(labels).not.toContain("Context");
		expect(labels).not.toContain("Trajectory");
		expect(labels).not.toContain("Agents");

		await act(async () => root.unmount());
		host.remove();
	});
});
