import "./happy-dom-shim";
import { afterEach, describe, expect, test } from "bun:test";
import { setLocale, t } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConnectionManager } from "../src/components/ConnectionManager";
import type { ConnectionState } from "../src/lib/connection/state";
import type { TargetStatusMap } from "../src/lib/connection/target-store";
import { type ConnectionTarget, createTarget, localTarget } from "../src/lib/connection/targets";

/**
 * Connection manager contract.
 *
 * The reported bug: pressing 断开 showed 无法连接本地守护进程, because the gate
 * was `if (!rpc)` and could not tell an intentional disconnect from a failed
 * attempt. These assertions pin the two halves of the fix — the calm surface
 * never carries failure copy or the failure-only actions, and the failure
 * surface never pretends the list is the whole story.
 */

setLocale("zh-CN");

const mounted = new Set<Root>();

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
});

function render(overrides: Partial<Parameters<typeof ConnectionManager>[0]> = {}): HTMLElement {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	mounted.add(root);
	const props: Parameters<typeof ConnectionManager>[0] = {
		state: "disconnected-by-user" as ConnectionState,
		targets: [localTarget()],
		statuses: {} as TargetStatusMap,
		daemonUrl: "ws://127.0.0.1:8300",
		activeTargetId: "local",
		busyId: null,
		lastError: null,
		detect: async () => "",
		platform: "win32",
		onConnect: () => {},
		onAdd: () => {},
		onRemove: () => {},
		onCopy: () => {},
		...overrides,
	};
	act(() => root.render(<ConnectionManager {...props} />));
	return host;
}

const q = (host: HTMLElement, selector: string): HTMLElement | null => host.querySelector(selector);

/** React reads `onChange` from the value setter, so a plain `input.value = x`
 *  never reaches the component; go through the prototype setter. */
function setInput(input: HTMLInputElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	act(() => {
		setter?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
const text = (host: HTMLElement): string => host.textContent ?? "";

describe("connection manager surfaces", () => {
	test("a deliberate disconnect shows the manager, never the failure copy", () => {
		const host = render({ state: "disconnected-by-user" });
		expect(q(host, '.gui-conn[data-state="disconnected-by-user"]')).not.toBeNull();
		expect(text(host)).toContain(t("settings.connectionDisconnected"));
		expect(text(host)).not.toContain(t("settings.cannotReachLocalDaemon"));
		// 导出诊断 / 重启 are the failure surface's business only.
		expect(text(host)).not.toContain(t("general.bootExportDiagnostics"));
		expect(text(host)).not.toContain(t("general.bootRestartApp"));
	});

	test("a failed attempt shows the failure copy and its recovery actions", () => {
		const host = render({
			state: "unreachable",
			lastError: "ECONNREFUSED 127.0.0.1:8300",
			children: <span data-testid="diagnostics">{t("general.bootExportDiagnostics")}</span>,
		});
		expect(text(host)).toContain(t("settings.cannotReachLocalDaemon"));
		expect(host.querySelector('[data-testid="diagnostics"]')).not.toBeNull();
		// It still lists the targets — a failure never replaces the list.
		expect(host.querySelectorAll(".gui-conn-row").length).toBe(1);
	});

	test("first launch is its own state, not an error", () => {
		const host = render({ state: "unconfigured", targets: [localTarget()] });
		expect(text(host)).toContain(t("settings.connectionUnconfigured"));
		expect(text(host)).not.toContain(t("settings.cannotReachLocalDaemon"));
	});

	test("a live connection keeps the manager calm with the row marked current", () => {
		const host = render({ state: "connected" });
		expect(q(host, '.gui-conn-status[data-status="connected"]')).not.toBeNull();
		expect(text(host)).toContain(t("settings.currentInstanceBadge"));
	});

	test("an attempt in flight marks its row, not the whole surface, as connecting", () => {
		const host = render({
			state: "starting",
			targets: [localTarget(), createTarget({ id: "b", label: "Build", url: "ws://b:1", kind: "manual" })],
			busyId: "b",
		});
		const rows = host.querySelectorAll(".gui-conn-row");
		expect(rows[0]?.getAttribute("data-status")).not.toBe("connecting");
		expect(rows[1]?.getAttribute("data-status")).toBe("connecting");
	});
});

describe("connection manager rows", () => {
	const ssh: ConnectionTarget = createTarget({
		id: "s1",
		label: "Build box",
		url: "ws://127.0.0.1:9400",
		kind: "ssh",
		sshHost: "me@build.example.com",
		remotePort: 8300,
	});

	test("a stored failure stays visible on its own row", () => {
		const host = render({
			state: "disconnected-by-user",
			targets: [localTarget(), ssh],
			statuses: { s1: { lastAttemptAt: 1_700_000_000_000, lastError: "timeout" } },
			activeTargetId: "s1",
		});
		const failed = q(host, '.gui-conn-row[data-status="failed"]');
		expect(failed).not.toBeNull();
		// Rows survive; the error belongs to the row, not to the surface.
		expect(host.querySelectorAll(".gui-conn-row").length).toBe(2);
		expect(host.textContent).not.toContain(t("settings.cannotReachLocalDaemon"));
	});

	test("an untouched target reads as not tried yet", () => {
		const host = render({ targets: [localTarget(), ssh], activeTargetId: null });
		expect(q(host, '.gui-conn-row[data-status="unknown"]')).not.toBeNull();
	});

	test("a past success reads as last used, never as a live connection", () => {
		// The reported flow: connect → 断开. The header says 已断开, so a row
		// claiming 已连接 would contradict it — the exact defect this pins.
		const host = render({
			state: "disconnected-by-user",
			targets: [localTarget(), ssh],
			statuses: { s1: { lastAttemptAt: 1_700_000_000_000, lastError: null } },
			activeTargetId: "s1",
		});
		expect(q(host, '.gui-conn-row[data-status="connected"]')).toBeNull();
		expect(q(host, '.gui-conn-status[data-status="connected"]')).toBeNull();
		expect(text(host)).not.toContain(t("settings.connectionStatusConnected"));
		expect(q(host, '.gui-conn-row[data-status="last-used"]')).not.toBeNull();
		expect(text(host)).toContain(t("settings.connectionDisconnected"));
	});

	test("two previously successful rows cannot both claim the connection", () => {
		const other: ConnectionTarget = createTarget({ id: "m1", label: "Laptop", url: "ws://h:1", kind: "manual" });
		const host = render({
			state: "disconnected-by-user",
			targets: [localTarget(), ssh, other],
			statuses: {
				s1: { lastAttemptAt: 1_700_000_000_000, lastError: null },
				m1: { lastAttemptAt: 1_700_000_100_000, lastError: null },
			},
			activeTargetId: "s1",
		});
		expect(host.querySelectorAll('.gui-conn-row[data-status="connected"]').length).toBe(0);
		expect(host.querySelectorAll('.gui-conn-row[data-status="last-used"]').length).toBe(2);
	});

	test("only the live client marks its own row connected", () => {
		const other: ConnectionTarget = createTarget({ id: "m1", label: "Laptop", url: "ws://h:1", kind: "manual" });
		const host = render({
			state: "connected",
			targets: [localTarget(), ssh, other],
			statuses: {
				s1: { lastAttemptAt: 1_700_000_000_000, lastError: null },
				m1: { lastAttemptAt: 1_700_000_100_000, lastError: null },
			},
			activeTargetId: "s1",
		});
		const connectedRows = host.querySelectorAll('.gui-conn-row[data-status="connected"]');
		expect(connectedRows.length).toBe(1);
		expect(connectedRows[0]?.getAttribute("data-kind")).toBe("ssh");
	});

	test("ssh rows explain the endpoint and expose a copyable tunnel command", () => {
		const copied: string[] = [];
		const host = render({
			targets: [localTarget(), ssh],
			onCopy: value => copied.push(value),
		});
		const details = Array.from(host.querySelectorAll<HTMLButtonElement>(".gui-conn-actions button")).find(
			button => button.getAttribute("aria-label") === t("settings.connectionDetails"),
		);
		expect(details).toBeDefined();
		act(() => details?.click());
		expect(text(host)).toContain("ssh -N -L 9400:127.0.0.1:8300 me@build.example.com");
		expect(text(host)).toContain(t("settings.connectionForwardingNote"));
		const copy = Array.from(host.querySelectorAll<HTMLButtonElement>(".gui-conn-command button")).find(
			button => button.getAttribute("aria-label") === t("settings.connectionCopyCommand"),
		);
		act(() => copy?.click());
		expect(copied).toEqual(["ssh -N -L 9400:127.0.0.1:8300 me@build.example.com"]);
	});

	test("the local row cannot be removed, a stored one can", () => {
		const removed: string[] = [];
		const host = render({ targets: [localTarget(), ssh], onRemove: id => removed.push(id) });
		const rows = host.querySelectorAll(".gui-conn-row");
		const removeButtons = (row: Element): HTMLButtonElement[] =>
			Array.from(row.querySelectorAll<HTMLButtonElement>(`button[aria-label="${t("general.remove")}"]`));
		expect(removeButtons(rows[0] as Element)).toHaveLength(0);
		const storedRemove = removeButtons(rows[1] as Element);
		expect(storedRemove).toHaveLength(1);
		act(() => storedRemove[0]?.click());
		expect(removed).toEqual(["s1"]);
	});

	test("connecting from a stored target hands that exact row to the host", () => {
		const connected: ConnectionTarget[] = [];
		const host = render({
			targets: [localTarget(), ssh],
			onConnect: target => connected.push(target),
		});
		const rows = Array.from(host.querySelectorAll(".gui-conn-row"));
		const sshConnect = rows[1]?.querySelector<HTMLButtonElement>(".gui-conn-connect");
		act(() => sshConnect?.click());
		expect(connected).toHaveLength(1);
		expect(connected[0]).toMatchObject({ id: "s1", url: "ws://127.0.0.1:9400", sshHost: "me@build.example.com" });
	});

	test("editing a stored target reuses its id instead of creating a second row", () => {
		const added: ConnectionTarget[] = [];
		const host = render({ targets: [localTarget(), ssh], onAdd: target => added.push(target) });
		const edit = Array.from(host.querySelectorAll<HTMLButtonElement>(".gui-conn-row button")).find(
			button => button.getAttribute("aria-label") === t("settings.edit"),
		);
		expect(edit).toBeDefined();
		act(() => edit?.click());
		// The form is seeded from the row, so saving without changes keeps it intact.
		const label = host.querySelector<HTMLInputElement>(".gui-conn-form input.gui-input");
		expect(label?.value).toBe("Build box");
		const submit = Array.from(host.querySelectorAll<HTMLButtonElement>(".gui-conn-form-actions button")).find(
			button => (button.textContent ?? "").includes(t("settings.testAndAddInstance")),
		);
		act(() => submit?.click());
		expect(added).toHaveLength(1);
		expect(added[0]).toMatchObject({ id: "s1", kind: "ssh", sshHost: "me@build.example.com" });
	});

	test("the manual ws:// form is one kind beside the others, not an advanced disclosure", () => {
		const host = render();
		const add = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(button =>
			(button.textContent ?? "").includes(t("settings.addInstance")),
		);
		act(() => add?.click());
		const kinds = Array.from(host.querySelectorAll('[role="tab"]')).map(tab => tab.textContent ?? "");
		expect(kinds.some(label => label.includes(t("settings.connectionKindManual")))).toBe(true);
		expect(kinds.some(label => label.includes(t("settings.connectionKindWsl")))).toBe(true);
		expect(host.querySelector("details")).toBeNull();
	});

	test("adding a manual target emits the normalized endpoint", () => {
		const added: ConnectionTarget[] = [];
		const host = render({ onAdd: target => added.push(target) });
		const add = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(button =>
			(button.textContent ?? "").includes(t("settings.addInstance")),
		);
		act(() => add?.click());
		const inputs = host.querySelectorAll<HTMLInputElement>(".gui-conn-form input.gui-input");
		const [label, url] = Array.from(inputs);
		setInput(label!, "Home");
		setInput(url!, "wss://daemon.example.com");
		const submit = Array.from(host.querySelectorAll<HTMLButtonElement>(".gui-conn-form-actions button")).find(
			button => (button.textContent ?? "").includes(t("settings.testAndAddInstance")),
		);
		act(() => submit?.click());
		expect(added).toHaveLength(1);
		expect(added[0]).toMatchObject({ kind: "manual", label: "Home", url: "wss://daemon.example.com" });
	});

	test("a missing name is reported instead of silently doing nothing", () => {
		const added: ConnectionTarget[] = [];
		const host = render({ onAdd: target => added.push(target) });
		const add = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(button =>
			(button.textContent ?? "").includes(t("settings.addInstance")),
		);
		act(() => add?.click());
		const submit = Array.from(host.querySelectorAll<HTMLButtonElement>(".gui-conn-form-actions button")).find(
			button => (button.textContent ?? "").includes(t("settings.testAndAddInstance")),
		);
		act(() => submit?.click());
		expect(added).toHaveLength(0);
		expect(host.querySelector('[role="alert"]')?.textContent).toContain(t("settings.connectionLabelRequired"));
	});
});

describe("connection manager WSL detection", () => {
	async function openWsl(host: HTMLElement): Promise<void> {
		const add = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(button =>
			(button.textContent ?? "").includes(t("settings.addInstance")),
		);
		await act(async () => {
			add?.click();
		});
		const wslTab = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(tab =>
			(tab.textContent ?? "").includes(t("settings.connectionKindWsl")),
		);
		await act(async () => {
			wslTab?.click();
			await Bun.sleep(10);
		});
	}

	test("two distributions become a picker with the default marked", async () => {
		const host = render({ detect: async () => "Ubuntu-22.04\r\nDebian\r\n" });
		await openWsl(host);
		const options = Array.from(host.querySelectorAll("option")).map(option => option.textContent ?? "");
		expect(options.some(option => option.includes("Ubuntu-22.04"))).toBe(true);
		expect(options.some(option => option.includes(t("settings.connectionDistroDefault")))).toBe(true);
		expect(options.some(option => option.includes("Debian"))).toBe(true);
	});

	test("zero distributions is answered, not left blank", async () => {
		const host = render({ detect: async () => "" });
		await openWsl(host);
		expect(text(host)).toContain(t("settings.connectionWslNone"));
		expect(host.querySelector("select")).toBeNull();
	});

	test("a failed probe says so and points at the manual form", async () => {
		const host = render({
			detect: async () => {
				throw new Error("wsl.exe not found");
			},
		});
		await openWsl(host);
		expect(text(host)).toContain(t("settings.connectionWslFailed", { error: "wsl.exe not found" }));
	});

	test("no bridge at all is 'cannot detect', never an empty list", async () => {
		const host = render({ detect: async () => null, platform: "win32" });
		await openWsl(host);
		expect(text(host)).toContain(t("settings.connectionWslUnavailable"));
		expect(text(host)).not.toContain(t("settings.connectionWslNone"));
	});

	test("outside Windows detection is named as inapplicable", async () => {
		const host = render({ detect: async () => null, platform: "darwin" });
		await openWsl(host);
		expect(text(host)).toContain(t("settings.connectionWslNotWindows"));
	});
});

describe("connection manager list scrolling", () => {
	test("the list itself never scrolls, so no nested scrollbar appears", () => {
		const host = render({
			targets: [
				localTarget(),
				...Array.from({ length: 12 }, (_, index) =>
					createTarget({ id: `t${index}`, label: `Row ${index}`, url: `ws://h${index}:1`, kind: "manual" }),
				),
			],
		});
		const list = q(host, ".gui-conn-list");
		expect(list).not.toBeNull();
		// Inline styles carry no scroller either — a nested scroller is the
		// failure this asserts against (M80 overflow contract).
		expect((list as HTMLElement).style.overflowY).toBe("");
		expect((list as HTMLElement).style.overflowX).toBe("");
	});

	test("every row exposes a focusable connect action for keyboard use", () => {
		const host = render({
			targets: [localTarget(), createTarget({ id: "b", label: "B", url: "ws://b:1", kind: "manual" })],
		});
		const connectButtons = Array.from(host.querySelectorAll<HTMLButtonElement>(".gui-conn-connect"));
		expect(connectButtons).toHaveLength(2);
		for (const button of connectButtons) expect(button.disabled).toBe(false);
	});

	test("while one attempt runs the other rows cannot start a second", () => {
		const host = render({
			targets: [localTarget(), createTarget({ id: "b", label: "B", url: "ws://b:1", kind: "manual" })],
			busyId: "b",
		});
		const connectButtons = Array.from(host.querySelectorAll<HTMLButtonElement>(".gui-conn-connect"));
		expect(connectButtons.every(button => button.disabled)).toBe(true);
	});
});
