import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { WorkspaceSessionInfo } from "@musepi/pi-wire";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WorkspaceView } from "../src/components/shell/WorkspaceView";
import { setLocale } from "../src/i18n/index.js";
import type { SessionClient } from "../src/lib/client";
import { writeArchivedSessions } from "../src/lib/session-archive";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
	void GlobalRegistrator.unregister();
});

const SESSION: WorkspaceSessionInfo = {
	id: "session-1",
	title: "Session one",
	cwd: "/work",
	messageCount: 1,
	working: false,
	paused: false,
	live: true,
	updatedAt: 1,
};

const roots: Root[] = [];

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) act(() => root.unmount());
	}
	document.body.innerHTML = "";
	localStorage.clear();
	// The archive store keeps an in-memory mirror; clearing storage alone would
	// leak this test's archive into the next one.
	writeArchivedSessions([]);
	setLocale("en-US");
});

function render(sessions: readonly WorkspaceSessionInfo[]): HTMLElement {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);
	act(() => root.render(<WorkspaceView client={{} as SessionClient} sessions={sessions} onSelect={() => {}} />));
	return host;
}

describe("WorkspaceView empty states", () => {
	it("says the host has no sessions when the directory is genuinely empty", () => {
		const host = render([]);
		expect(host.querySelector(".sh-workspace-empty")?.textContent).toBe("No sessions yet");
		expect(host.querySelectorAll(".sh-ws-card")).toHaveLength(0);
	});

	it("says every session is archived when the active filter hides all of them", () => {
		// The active view filters archived ids out, so a host with sessions can
		// still render an empty grid. Calling that "No sessions yet" claims the
		// host is empty, and leaving it blank reads as "still loading".
		writeArchivedSessions([{ sessionId: SESSION.id, archivedAt: 1 }]);
		const host = render([SESSION]);
		expect(host.querySelectorAll(".sh-ws-card")).toHaveLength(0);
		const hint = host.querySelector(".sh-workspace-empty")?.textContent ?? "";
		expect(hint).toContain("archived");
		expect(hint).not.toBe("No sessions yet");
	});

	it("shows the card and no hint when a session is visible", () => {
		const host = render([SESSION]);
		expect(host.querySelectorAll(".sh-ws-card")).toHaveLength(1);
		expect(host.querySelector(".sh-workspace-empty")).toBeNull();
	});

	it("keeps the sidebar's own empty line in step with the grid", () => {
		writeArchivedSessions([{ sessionId: SESSION.id, archivedAt: 1 }]);
		const host = render([SESSION]);
		const sidebarEmpty = host.querySelector(".sh-ws-sidebar-empty")?.textContent ?? "";
		expect(sidebarEmpty).toContain("archived");
	});
});
