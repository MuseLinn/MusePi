import "./happy-dom-shim";
import { afterEach, describe, expect, test } from "bun:test";
import { setLocale, t } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConnectionGate } from "../src/components/ConnectionGate";
import type { ConnectionFacts } from "../src/lib/connection/state";
import { localTarget } from "../src/lib/connection/targets";

/**
 * The app-layer gate.
 *
 * The reducer suite proves the state model; this proves the surface actually
 * chosen for each state, because the reported bug lived in the gate — the
 * shell rendered 无法连接本地守护进程 whenever no client was open, whatever
 * the reason. A regression here must fail here, not only in the reducer.
 */

setLocale("zh-CN");

const mounted = new Set<Root>();

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
});

const facts = (overrides: Partial<ConnectionFacts> = {}): ConnectionFacts => ({
	connected: false,
	attempting: false,
	disconnectedByUser: false,
	lastAttemptFailed: false,
	hasTargets: true,
	...overrides,
});

function render(overrides: Partial<Parameters<typeof ConnectionGate>[0]> = {}): HTMLElement {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	mounted.add(root);
	const props: Parameters<typeof ConnectionGate>[0] = {
		facts: facts({ disconnectedByUser: true }),
		targets: [localTarget()],
		statuses: {},
		daemonUrl: "ws://127.0.0.1:8300",
		activeTargetId: "local",
		busyId: null,
		lastError: null,
		connectError: null,
		error: null,
		detect: async () => "",
		platform: "win32",
		onConnect: () => {},
		onAdd: () => {},
		onRemove: () => {},
		onCopy: () => {},
		...overrides,
	};
	act(() => root.render(<ConnectionGate {...props} />));
	return host;
}

const text = (host: HTMLElement): string => host.textContent ?? "";

describe("connection gate", () => {
	test("a deliberate disconnect chooses the manager, not the failure page", () => {
		const host = render({ facts: facts({ disconnectedByUser: true }) });
		expect(host.querySelector('[data-connection-state="disconnected-by-user"]')).not.toBeNull();
		expect(host.querySelector(".gui-conn")).not.toBeNull();
		expect(text(host)).toContain(t("settings.connectionDisconnected"));
		expect(text(host)).not.toContain(t("settings.cannotReachLocalDaemon"));
		expect(text(host)).not.toContain(t("general.bootExportDiagnostics"));
		expect(text(host)).not.toContain(t("general.bootRestartApp"));
	});

	test("a deliberate disconnect wins over a stale failure from an earlier attempt", () => {
		const host = render({ facts: facts({ disconnectedByUser: true, lastAttemptFailed: true }) });
		expect(host.querySelector('[data-connection-state="disconnected-by-user"]')).not.toBeNull();
		expect(text(host)).not.toContain(t("settings.cannotReachLocalDaemon"));
	});

	test("a failed attempt chooses the failure page with its diagnostics", () => {
		const host = render({
			facts: facts({ lastAttemptFailed: true }),
			connectError: "ECONNREFUSED 127.0.0.1:8300",
		});
		expect(host.querySelector('[data-connection-state="unreachable"]')).not.toBeNull();
		expect(text(host)).toContain(t("settings.cannotReachLocalDaemon"));
		expect(text(host)).toContain("ECONNREFUSED 127.0.0.1:8300");
		expect(text(host)).toContain(t("general.bootExportDiagnostics"));
		// The list is still there: a failure never replaces the endpoints.
		expect(host.querySelectorAll(".gui-conn-row").length).toBe(1);
	});

	test("a first launch is its own calm state, never an error", () => {
		const host = render({ facts: facts({ hasTargets: false }) });
		expect(host.querySelector('[data-connection-state="unconfigured"]')).not.toBeNull();
		expect(text(host)).toContain(t("settings.connectionUnconfigured"));
		expect(text(host)).not.toContain(t("settings.cannotReachLocalDaemon"));
		expect(text(host)).not.toContain(t("general.bootExportDiagnostics"));
	});

	test("an attempt in flight names its row and keeps the failure actions away", () => {
		const host = render({ facts: facts({ attempting: true }), busyId: "local" });
		expect(host.querySelector('[data-connection-state="starting"]')).not.toBeNull();
		expect(host.querySelector('.gui-conn-row[data-status="connecting"]')).not.toBeNull();
		expect(text(host)).not.toContain(t("settings.cannotReachLocalDaemon"));
	});

	test("a live client keeps the manager and marks the current row", () => {
		const host = render({ facts: facts({ connected: true }) });
		expect(host.querySelector('[data-connection-state="connected"]')).not.toBeNull();
		expect(host.querySelector('.gui-conn-status[data-status="connected"]')).not.toBeNull();
		expect(text(host)).not.toContain(t("settings.cannotReachLocalDaemon"));
	});
});
