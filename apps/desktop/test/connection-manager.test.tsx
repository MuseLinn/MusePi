import "./happy-dom-shim";
import { afterEach, describe, expect, test } from "bun:test";
import { setLocale, t } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConnectionManager } from "../src/components/ConnectionManager";
import type { CatalogHost, ManagedTargetStatus } from "../src/lib/connection/remote-lifecycle";
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

/**
 * Reach one transport in the form.
 *
 * The form leads with transport cards; only a container additionally asks
 * *where* it runs, because that is the one transport that can be on either
 * machine. Callers name the transport they want, so a rename on the form does
 * not silently re-point a test at a different one.
 */
async function chooseTransport(
	host: HTMLElement,
	transport: "ssh" | "docker" | "wsl",
	location?: "local" | "remote",
): Promise<void> {
	const labels: Record<typeof transport, string> = {
		ssh: t("settings.connectionKindSsh"),
		docker: t("settings.connectionKindDocker"),
		wsl: t("settings.connectionKindWsl"),
	};
	const card = Array.from(host.querySelectorAll<HTMLElement>(".gui-conn-transport-card")).find(
		node => (node.querySelector(".gui-conn-transport-label")?.textContent ?? "") === labels[transport],
	);
	expect(card).toBeDefined();
	await act(async () => {
		card?.click();
		await Bun.sleep(20);
	});
	if (transport !== "docker" || !location) return;
	const group = Array.from(host.querySelectorAll<HTMLElement>('.gui-conn-form [role="radiogroup"]')).find(
		node => node.getAttribute("aria-label") === t("settings.instanceLocation"),
	);
	expect(group).toBeDefined();
	const wanted = location === "local" ? t("settings.locationThisComputer") : t("settings.locationRemoteHost");
	const chip = Array.from(group!.querySelectorAll<HTMLButtonElement>('button[role="radio"]')).find(
		button => (button.textContent ?? "").trim() === wanted,
	);
	expect(chip).toBeDefined();
	await act(async () => {
		chip?.click();
		await Bun.sleep(20);
	});
}

function render(overrides: Partial<Parameters<typeof ConnectionManager>[0]> = {}): HTMLElement {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	mounted.add(root);
	const props: Parameters<typeof ConnectionManager>[0] = {
		state: "disconnected-by-user" as ConnectionState,
		targets: [localTarget()],
		statuses: {} as TargetStatusMap,
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

/** Drive the wired React change handler with the native value setter. */
function setInput(input: HTMLInputElement, value: string): void {
	const propsKey = Object.keys(input).find(key => key.startsWith("__reactProps$"));
	const props = (input as unknown as Record<string, { onChange?: (event: { target: HTMLInputElement }) => void }>)[
		propsKey ?? ""
	];
	if (!props?.onChange) throw new Error("input has no React onChange");
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	act(() => {
		setter?.call(input, value);
		props.onChange!({ target: input });
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
		expect(host.querySelector('[data-testid="diagnostics"]') !== null).toBe(true);
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
		expect(!!q(host, '.gui-conn-row[data-status="connected"]')).toBe(false);
		expect(!!q(host, '.gui-conn-status[data-status="connected"]')).toBe(false);
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
		expect(details !== undefined).toBe(true);
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
		expect(edit !== undefined).toBe(true);
		act(() => edit?.click());
		// The form is seeded from the row, so saving without changes keeps it intact.
		const label = host.querySelector<HTMLInputElement>(".gui-conn-form input.gui-input");
		expect(label?.value).toBe("Build box");
		const submit = Array.from(host.querySelectorAll<HTMLButtonElement>(".gui-conn-form-actions button")).find(
			button => (button.textContent ?? "").includes(t("settings.connectionAddTarget")),
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
		// The form opens on transport cards: the three ways to reach a daemon,
		// each stating what it is for. It is not an advanced disclosure.
		const cards = Array.from(host.querySelectorAll<HTMLElement>(".gui-conn-transport-card")).map(
			card => card.querySelector(".gui-conn-transport-label")?.textContent ?? "",
		);
		expect(cards).toEqual([
			t("settings.connectionKindSsh"),
			t("settings.connectionKindDocker"),
			t("settings.connectionKindWsl"),
		]);
		expect(!!host.querySelector("details")).toBe(false);
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
			button => (button.textContent ?? "").includes(t("settings.connectionAddTarget")),
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
			button => (button.textContent ?? "").includes(t("settings.connectionAddTarget")),
		);
		act(() => submit?.click());
		expect(added).toHaveLength(0);
		expect(host.querySelector('[role="alert"]')?.textContent).toContain(t("settings.connectionLabelRequired"));
	});

	test("a bare host:port is accepted and normalized, the way the instance dialog takes it", () => {
		const added: ConnectionTarget[] = [];
		const host = render({ onAdd: target => added.push(target) });
		const add = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(button =>
			(button.textContent ?? "").includes(t("settings.addInstance")),
		);
		act(() => add?.click());
		const inputs = host.querySelectorAll<HTMLInputElement>(".gui-conn-form input.gui-input");
		const [label, url] = Array.from(inputs);
		setInput(label!, "Dev box");
		setInput(url!, "127.0.0.1:9000");
		const submit = Array.from(host.querySelectorAll<HTMLButtonElement>(".gui-conn-form-actions button")).find(
			button => (button.textContent ?? "").includes(t("settings.connectionAddTarget")),
		);
		act(() => submit?.click());
		expect(added).toHaveLength(1);
		expect(added[0]).toMatchObject({ kind: "manual", url: "ws://127.0.0.1:9000" });
	});

	test("a URL that is not a daemon endpoint is rejected in the form, not stored", () => {
		// This value becomes the next launch's boot endpoint. Storing `ftp://nope`
		// used to reach boot, where `new URL` threw past every failure record and
		// the gate derived a calm manager after a launch that never connected.
		const added: ConnectionTarget[] = [];
		const host = render({ onAdd: target => added.push(target) });
		const add = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(button =>
			(button.textContent ?? "").includes(t("settings.addInstance")),
		);
		act(() => add?.click());
		const inputs = host.querySelectorAll<HTMLInputElement>(".gui-conn-form input.gui-input");
		const [label, url] = Array.from(inputs);
		setInput(label!, "Nope");
		setInput(url!, "ftp://nope");
		const submit = Array.from(host.querySelectorAll<HTMLButtonElement>(".gui-conn-form-actions button")).find(
			button => (button.textContent ?? "").includes(t("settings.connectionAddTarget")),
		);
		act(() => submit?.click());
		expect(added).toHaveLength(0);
		expect(host.querySelector('[role="alert"]')?.textContent).toContain(t("settings.instanceUrlInvalid"));
		// The form stays open with the bad value, so it can be corrected.
		expect(!!host.querySelector(".gui-conn-form")).toBe(true);
	});
});

/**
 * The transport cards.
 *
 * The form used to open on two chip rows and nothing else, so a user picked a
 * vocabulary before knowing which transport they wanted. The cards lead with
 * the transport — the thing actually being configured — and carry each
 * transport's own readiness, so a container or a WSL that cannot work says so
 * where it is offered rather than after a failed submit.
 */
describe("connection manager transports", () => {
	async function openForm(): Promise<HTMLElement> {
		const host = render();
		const add = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(button =>
			(button.textContent ?? "").includes(t("settings.addInstance")),
		);
		await act(async () => add?.click());
		return host;
	}

	test("the form offers ssh, docker and WSL as cards", async () => {
		const host = await openForm();
		const cards = Array.from(host.querySelectorAll<HTMLElement>(".gui-conn-transport-card"));
		expect(cards).toHaveLength(3);
		const labels = cards.map(card => card.querySelector(".gui-conn-transport-label")?.textContent ?? "");
		expect(labels).toEqual([
			t("settings.connectionKindSsh"),
			t("settings.connectionKindDocker"),
			t("settings.connectionKindWsl"),
		]);
		// Each card states what it is for, so the three are distinguishable
		// without selecting one first.
		for (const card of cards) {
			expect((card.querySelector(".gui-conn-transport-hint")?.textContent ?? "").length).toBeGreaterThan(0);
		}
	});

	test("choosing the ssh card switches the form to a remote host", async () => {
		const host = await openForm();
		const sshCard = Array.from(host.querySelectorAll<HTMLElement>(".gui-conn-transport-card")).find(card =>
			(card.textContent ?? "").includes(t("settings.connectionKindSsh")),
		);
		await act(async () => {
			sshCard?.click();
			await Bun.sleep(20);
		});
		// The ssh card IS the remote case: choosing it has to put the form in a
		// remote state so the host field appears, without a second chip asking the
		// same question the card already answered.
		const hostInput = Array.from(host.querySelectorAll<HTMLInputElement>(".gui-conn-form input.gui-input")).find(
			input => input.placeholder === t("settings.connectionSshHostPlaceholder"),
		);
		expect(hostInput !== undefined).toBe(true);
	});

	test("a container card says when the docker probe cannot answer", async () => {
		(globalThis as { musepiShell?: unknown }).musepiShell = {
			detectDocker: async () => ({ available: false, reason: "daemon-unreachable" }),
		};
		const host = render();
		const add = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(button =>
			(button.textContent ?? "").includes(t("settings.addInstance")),
		);
		await act(async () => add?.click());
		await chooseTransport(host, "docker", "local");
		await act(async () => {
			await Bun.sleep(40);
		});
		delete (globalThis as { musepiShell?: unknown }).musepiShell;
		const card = Array.from(host.querySelectorAll<HTMLElement>(".gui-conn-transport-card")).find(node =>
			(node.textContent ?? "").includes(t("settings.connectionKindDocker")),
		);
		// Blocked at the point of choosing, not after a submit that could not work.
		expect(card?.querySelector('[data-tone="blocked"]') !== null).toBe(true);
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
		await chooseTransport(host, "wsl");
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
		expect(!!host.querySelector("select")).toBe(false);
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

/**
 * Managed lifecycle in the row.
 *
 * The reported gap this closes: a tunnel that fails had nowhere to say why. The
 * row now carries the supervisor's status and — the part that matters — the
 * process's own stderr, so "Permission denied (publickey)" reaches the user
 * instead of a generic 无法连接.
 */
describe("connection manager managed rows", () => {
	const ssh: ConnectionTarget = createTarget({
		id: "s1",
		label: "Build box",
		url: "ws://127.0.0.1:9400",
		kind: "ssh",
		sshHost: "me@build.example.com",
		remotePort: 8300,
	});

	const status = (over: Partial<ManagedTargetStatus> = {}): ManagedTargetStatus => ({
		targetId: "s1",
		kind: "ssh",
		status: "running",
		pid: 4242,
		startedAt: 1,
		listeningPort: 9400,
		error: null,
		stderr: "",
		command: "ssh -N …",
		...over,
	});

	/** Open the row's detail disclosure. */
	async function expandFirstRow(host: HTMLElement): Promise<void> {
		const details = Array.from(host.querySelectorAll<HTMLButtonElement>(".gui-conn-actions button")).find(
			button => button.getAttribute("aria-label") === t("settings.connectionDetails"),
		);
		await act(async () => {
			details?.click();
		});
	}

	test("a failed tunnel shows ssh's own stderr in its row", async () => {
		const host = render({
			targets: [localTarget(), ssh],
			managed: {
				s1: status({
					status: "failed",
					stderr: "Permission denied (publickey).",
					error: "ssh exited with code 255",
				}),
			},
			onStartManaged: () => {},
		});
		await expandFirstRow(host);
		const row = q(host, '.gui-conn-row[data-kind="ssh"]');
		expect(row).not.toBeNull();
		expect(row?.getAttribute("data-managed")).toBe("failed");
		const detail = row?.querySelector(".gui-conn-managed-error");
		expect(detail?.textContent).toContain("Permission denied (publickey).");
		// The generic summary must not stand in front of the real reason.
		expect(detail?.textContent).not.toContain("ssh exited with code 255");
	});

	test("a running tunnel is named as started by MusePi, not as connected", () => {
		const host = render({ targets: [localTarget(), ssh], managed: { s1: status() }, onStartManaged: () => {} });
		expect(text(host)).toContain(t("settings.connectionManagedRunning"));
		// The process is running; the daemon connection is a separate fact.
		expect(text(host)).not.toContain(t("settings.connectionStatusConnected"));
	});

	test("a stopped tunnel reads idle rather than failed", () => {
		const host = render({
			targets: [localTarget(), ssh],
			managed: { s1: status({ status: "stopped" }) },
			onStartManaged: () => {},
		});
		expect(q(host, '.gui-conn-row[data-managed="failed"]')).toBeNull();
		expect(text(host)).not.toContain(t("settings.connectionManagedFailed"));
	});

	test("the start control offers start, then stop once it runs", async () => {
		const started: string[] = [];
		const stopped: string[] = [];
		const host = render({
			targets: [localTarget(), ssh],
			onStartManaged: target => started.push(target.id),
			onStopManaged: target => stopped.push(target.id),
		});
		const start = host.querySelector<HTMLButtonElement>(".gui-conn-manage");
		expect(start?.getAttribute("aria-label")).toBe(t("settings.connectionStartManaged"));
		await act(async () => start?.click());
		expect(started).toEqual(["s1"]);

		const running = render({
			targets: [localTarget(), ssh],
			managed: { s1: status() },
			onStartManaged: () => {},
			onStopManaged: target => stopped.push(target.id),
		});
		const stop = running.querySelector<HTMLButtonElement>(".gui-conn-manage");
		expect(stop?.getAttribute("aria-label")).toBe(t("settings.connectionStopManaged"));
		await act(async () => stop?.click());
		expect(stopped).toEqual(["s1"]);
	});

	test("a row without a bridge keeps its copyable command and says so", async () => {
		// No onStartManaged: the shell has no process bridge, so the row must not
		// pretend it can start anything — it offers the command instead.
		const host = render({ targets: [localTarget(), ssh] });
		expect(q(host, ".gui-conn-manage")).toBeNull();
		await expandFirstRow(host);
		expect(text(host)).toContain(t("settings.connectionManagedNoBridge"));
		expect(text(host)).toContain("ssh -N");
	});
});

/**
 * The catalog reaching the surface.
 *
 * The review's finding was exact: the parser and merge were correct and tested,
 * and no surface ever read them — so a host the user configured for ssh(1) was
 * still invisible, which is the gap this mission exists to close. These tests
 * assert the surface, not the functions: a catalog-only host must be
 * *selectable* here, and choosing it must carry its facts into the row.
 */
describe("connection manager catalog", () => {
	const catalog: CatalogHost[] = [
		{ name: "managed-box", host: "managed.example.com", source: "musepi" },
		{ name: "from-ssh-config", host: "cfg.example.com", username: "me", port: 2222, source: "ssh-config" },
		{ name: "jump-chain", host: "10.0.0.5", proxyJump: "bastion", source: "ssh-config" },
		// A chain that comes from MusePi's own store. The only chain fixture used
		// to be ssh-config-sourced, which is why a MusePi entry losing its chain
		// passed every test while dialling the destination directly.
		{ name: "musepi-jump", host: "10.0.0.9", username: "me", proxyJump: "musepi-bastion", source: "musepi" },
	];

	async function openSshForm(host: HTMLElement): Promise<void> {
		const add = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(button =>
			(button.textContent ?? "").includes(t("settings.addInstance")),
		);
		await act(async () => add?.click());
		await chooseTransport(host, "ssh");
	}

	test("an ssh-config-only host is offered in the instance form", async () => {
		const host = render({ targets: [localTarget()], catalog });
		await openSshForm(host);
		const options = Array.from(host.querySelectorAll("option")).map(option => option.textContent ?? "");
		expect(options.some(option => option.includes("from-ssh-config"))).toBe(true);
		// The provenance is visible: the user can tell this came from their own
		// ssh config rather than from MusePi's store.
		expect(options.some(option => option.includes(t("settings.connectionCatalogFromSshConfig")))).toBe(true);
	});

	test("choosing a catalog host fills its facts, and the added target carries them", async () => {
		const added: ConnectionTarget[] = [];
		const host = render({ targets: [localTarget()], catalog, onAdd: target => added.push(target) });
		await openSshForm(host);
		const select = host.querySelector<HTMLSelectElement>(".gui-conn-form select");
		expect(select !== null).toBe(true);
		const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
		await act(async () => {
			setter?.call(select, "from-ssh-config");
			select?.dispatchEvent(new Event("change", { bubbles: true }));
		});
		const submit = Array.from(host.querySelectorAll<HTMLButtonElement>(".gui-conn-form-actions button")).find(
			button => (button.textContent ?? "").includes(t("settings.connectionAddTarget")),
		);
		await act(async () => submit?.click());
		expect(added).toHaveLength(1);
		// The facts the tunnel needs, not just the label.
		expect(added[0]).toMatchObject({ kind: "ssh", sshHost: "me@cfg.example.com", sshPort: 2222 });
	});

	test("a ProxyJump entry survives into the added target", async () => {
		const added: ConnectionTarget[] = [];
		const host = render({ targets: [localTarget()], catalog, onAdd: target => added.push(target) });
		await openSshForm(host);
		const select = host.querySelector<HTMLSelectElement>(".gui-conn-form select");
		const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
		await act(async () => {
			setter?.call(select, "jump-chain");
			select?.dispatchEvent(new Event("change", { bubbles: true }));
		});
		const submit = Array.from(host.querySelectorAll<HTMLButtonElement>(".gui-conn-form-actions button")).find(
			button => (button.textContent ?? "").includes(t("settings.connectionAddTarget")),
		);
		await act(async () => submit?.click());
		expect(added[0]).toMatchObject({ proxyJump: "bastion" });
	});

	test("a MusePi-sourced chain survives into the added target", async () => {
		// The instance form's half of the merge: a host recorded in ssh.json with
		// its chain must produce a row that dials through it, not the destination.
		const added: ConnectionTarget[] = [];
		const host = render({ targets: [localTarget()], catalog, onAdd: target => added.push(target) });
		await openSshForm(host);
		const select = host.querySelector<HTMLSelectElement>(".gui-conn-form select");
		const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
		await act(async () => {
			setter?.call(select, "musepi-jump");
			select?.dispatchEvent(new Event("change", { bubbles: true }));
		});
		const submit = Array.from(host.querySelectorAll<HTMLButtonElement>(".gui-conn-form-actions button")).find(
			button => (button.textContent ?? "").includes(t("settings.connectionAddTarget")),
		);
		await act(async () => submit?.click());
		expect(added).toHaveLength(1);
		expect(added[0]).toMatchObject({ kind: "ssh", sshHost: "me@10.0.0.9", proxyJump: "musepi-bastion" });
	});

	test("no catalog leaves the manual form exactly as it was", async () => {
		const host = render({ targets: [localTarget()] });
		await openSshForm(host);
		const labels = Array.from(host.querySelectorAll(".gui-field-label")).map(node => node.textContent ?? "");
		expect(labels).not.toContain(t("settings.connectionCatalogHost"));
		// The manual host input is still there and still usable.
		expect(labels).toContain(t("settings.connectionSshHost"));
	});
});

/**
 * Docker detection in the form.
 *
 * The distinction that matters: "no container publishes this port" and "the
 * container list could not be read" are different answers, and a socket
 * permission error must not be rendered as the former.
 */
describe("connection manager docker probe", () => {
	async function openDockerForm(): Promise<HTMLElement> {
		const host = render({ targets: [localTarget()] });
		const add = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(button =>
			(button.textContent ?? "").includes(t("settings.addInstance")),
		);
		await act(async () => add?.click());
		await chooseTransport(host, "docker", "local");
		return host;
	}

	test("a failed container list keeps the daemon's own text", async () => {
		(globalThis as { musepiShell?: unknown }).musepiShell = {
			detectDocker: async () => ({ available: true }),
			dockerContainers: async () => ({
				ok: false,
				reason: "daemon-unreachable",
				error: "permission denied while trying to connect to the Docker daemon socket",
			}),
		};
		const host = await openDockerForm();
		delete (globalThis as { musepiShell?: unknown }).musepiShell;
		const text = host.textContent ?? "";
		expect(text).toContain(t("settings.connectionDockerListFailed"));
		expect(text).toContain("permission denied");
		// The failure is not dressed up as an empty, healthy list.
		expect(text).not.toContain(t("settings.connectionDockerNone"));
	});

	test("an empty list is still its own answer", async () => {
		(globalThis as { musepiShell?: unknown }).musepiShell = {
			detectDocker: async () => ({ available: true }),
			dockerContainers: async () => ({ ok: true, containers: [] }),
		};
		const host = await openDockerForm();
		delete (globalThis as { musepiShell?: unknown }).musepiShell;
		expect(host.textContent ?? "").toContain(t("settings.connectionDockerNone"));
		expect(host.textContent ?? "").not.toContain(t("settings.connectionDockerListFailed"));
	});

	test("containers publishing the port are offered with their mapping", async () => {
		(globalThis as { musepiShell?: unknown }).musepiShell = {
			detectDocker: async () => ({ available: true }),
			dockerContainers: async () => ({
				ok: true,
				containers: [{ name: "musepi-dev", image: "musepi", hostPort: 8300, containerPort: 8300 }],
			}),
		};
		const host = await openDockerForm();
		delete (globalThis as { musepiShell?: unknown }).musepiShell;
		const options = Array.from(host.querySelectorAll("option")).map(option => option.textContent ?? "");
		expect(options.some(option => option.includes("musepi-dev"))).toBe(true);
	});
});

/**
 * A container on another machine.
 *
 * Two things have to be true for this to be a feature rather than a field on a
 * form: the probe must ask *that* host's docker, and the row must remember the
 * host so a start knows where to go. Both are asserted through the same
 * interaction a user performs.
 */
describe("connection manager remote container", () => {
	test("probing a remote container asks the named host, not this machine", async () => {
		const probed: Array<{ transport?: { destination?: string } } | undefined> = [];
		(globalThis as { musepiShell?: unknown }).musepiShell = {
			detectDocker: async (input?: { transport?: { destination?: string } }) => {
				probed.push(input);
				return { available: true };
			},
			dockerContainers: async (input?: { transport?: { destination?: string } }) => {
				probed.push(input);
				return { ok: true, containers: [] };
			},
		};
		const host = render({ targets: [localTarget()] });
		const add = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(button =>
			(button.textContent ?? "").includes(t("settings.addInstance")),
		);
		await act(async () => add?.click());
		await chooseTransport(host, "docker", "remote");

		// Naming the host is what releases the probe; until then there is nothing
		// truthful to ask about.
		const hostInput = Array.from(host.querySelectorAll<HTMLInputElement>(".gui-conn-form input.gui-input")).find(
			input => input.placeholder === t("settings.connectionSshHostPlaceholder"),
		);
		expect(hostInput !== undefined).toBe(true);
		setInput(hostInput!, "me@build");
		await act(async () => {
			await Bun.sleep(30);
		});
		delete (globalThis as { musepiShell?: unknown }).musepiShell;

		// The first probe ran for this machine the moment the container card was
		// chosen; the one after naming a host must be about that host.
		expect(probed.length).toBeGreaterThan(0);
		expect(probed.at(-1)?.transport?.destination).toBe("me@build");
	});

	test("the added row keeps the host so a start knows where to go", async () => {
		(globalThis as { musepiShell?: unknown }).musepiShell = {
			detectDocker: async () => ({ available: true }),
			dockerContainers: async () => ({ ok: true, containers: [] }),
		};
		const added: ConnectionTarget[] = [];
		const host = render({ targets: [localTarget()], onAdd: target => added.push(target) });
		const add = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(button =>
			(button.textContent ?? "").includes(t("settings.addInstance")),
		);
		await act(async () => add?.click());
		await chooseTransport(host, "docker", "remote");

		const form = host.querySelector<HTMLElement>(".gui-conn-form")!;
		const fieldFor = (label: string): HTMLInputElement | null => {
			const field = Array.from(form.querySelectorAll<HTMLElement>(".gui-field")).find(
				node => node.querySelector(".gui-field-label")?.textContent === label,
			);
			return field?.querySelector<HTMLInputElement>("input") ?? null;
		};
		setInput(fieldFor(t("settings.instanceLabel"))!, "Build box");
		setInput(fieldFor(t("settings.connectionSshHost"))!, "me@build");
		setInput(fieldFor(t("settings.connectionContainer"))!, "musepi-dev");
		await act(async () => {
			await Bun.sleep(10);
		});
		const submit = Array.from(host.querySelectorAll<HTMLButtonElement>(".gui-conn-form-actions button")).find(
			button => (button.textContent ?? "").includes(t("settings.connectionAddTarget")),
		);
		await act(async () => submit?.click());
		delete (globalThis as { musepiShell?: unknown }).musepiShell;

		expect(added).toHaveLength(1);
		expect(added[0].kind).toBe("docker");
		expect(added[0].sshHost).toBe("me@build");
		expect(added[0].container).toBe("musepi-dev");
	});
});
