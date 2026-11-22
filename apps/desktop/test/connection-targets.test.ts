import "./happy-dom-shim";
import { beforeEach, describe, expect, test } from "bun:test";
import {
	type ConnectionFacts,
	type ConnectionState,
	deriveConnectionState,
	showsFailureCopy,
	showsManager,
} from "../src/lib/connection/state";
import {
	bootTargetFor,
	dropTarget,
	loadChosenTargetId,
	loadStoredTargets,
	loadTargetStatuses,
	loadTargets,
	recordTargetStatus,
	saveChosenTargetId,
	saveTargetStatuses,
	saveTargets,
	storeTarget,
} from "../src/lib/connection/target-store";
import {
	asTarget,
	bootTarget,
	createTarget,
	DEFAULT_DAEMON_PORT,
	daemonPortOf,
	isLoopbackUrl,
	LOCAL_TARGET_ID,
	localTarget,
	removeTarget,
	stripToken,
	targetCommand,
	targetPublishHint,
	upsertTarget,
} from "../src/lib/connection/targets";
import { detectWsl, parseWslDistroList, type WslRunner } from "../src/lib/connection/wsl";

const facts = (overrides: Partial<ConnectionFacts> = {}): ConnectionFacts => ({
	connected: false,
	attempting: false,
	disconnectedByUser: false,
	lastAttemptFailed: false,
	hasTargets: true,
	...overrides,
});

const ALL_STATES: ConnectionState[] = ["connected", "starting", "disconnected-by-user", "unreachable", "unconfigured"];

describe("connection state model", () => {
	test("each fact combination resolves to its own state", () => {
		expect(deriveConnectionState(facts({ connected: true }))).toBe("connected");
		expect(deriveConnectionState(facts({ attempting: true }))).toBe("starting");
		expect(deriveConnectionState(facts({ disconnectedByUser: true }))).toBe("disconnected-by-user");
		expect(deriveConnectionState(facts({ lastAttemptFailed: true }))).toBe("unreachable");
		expect(deriveConnectionState(facts({ hasTargets: false }))).toBe("unconfigured");
	});

	test("every state is reachable from some facts", () => {
		const reached = new Set<ConnectionState>([
			deriveConnectionState(facts({ connected: true })),
			deriveConnectionState(facts({ attempting: true })),
			deriveConnectionState(facts({ disconnectedByUser: true })),
			deriveConnectionState(facts({ lastAttemptFailed: true })),
			deriveConnectionState(facts({ hasTargets: false })),
		]);
		expect(reached.size).toBe(ALL_STATES.length);
	});

	test("a deliberate disconnect never wins over a live connection or a live attempt", () => {
		expect(deriveConnectionState(facts({ disconnectedByUser: true, connected: true }))).toBe("connected");
		expect(deriveConnectionState(facts({ disconnectedByUser: true, attempting: true }))).toBe("starting");
	});

	test("a stale failure is not shown after the user disconnects deliberately", () => {
		// The reported bug in one assertion: 断开 after a failed attempt used to
		// still land on 无法连接, because the gate only knew "no client".
		expect(deriveConnectionState(facts({ disconnectedByUser: true, lastAttemptFailed: true }))).toBe(
			"disconnected-by-user",
		);
	});

	test("a failed attempt never reads as the calm manager", () => {
		expect(showsManager(deriveConnectionState(facts({ lastAttemptFailed: true })))).toBe(false);
		expect(showsFailureCopy(deriveConnectionState(facts({ lastAttemptFailed: true })))).toBe(true);
	});

	test("only unreachable shows the failure copy; only the calm states show the manager", () => {
		const failure = ALL_STATES.filter(showsFailureCopy);
		const manager = ALL_STATES.filter(showsManager);
		expect(failure).toEqual(["unreachable"]);
		expect(manager).toEqual(["disconnected-by-user", "unconfigured"]);
		expect(failure.some(state => manager.includes(state))).toBe(false);
	});
});

describe("connection targets", () => {
	test("the local row always exists and is never removable", () => {
		const targets = removeTarget([localTarget()], LOCAL_TARGET_ID);
		expect(targets).toHaveLength(1);
		expect(targets[0]?.kind).toBe("local");
		expect(targets[0]?.url).toBe(`ws://127.0.0.1:${DEFAULT_DAEMON_PORT}`);
	});

	test("loopback detection covers the three spellings the shell special-cases", () => {
		expect(isLoopbackUrl("ws://127.0.0.1:8300")).toBe(true);
		expect(isLoopbackUrl("ws://localhost:8300")).toBe(true);
		expect(isLoopbackUrl("ws://[::1]:8300")).toBe(true);
		expect(isLoopbackUrl("wss://daemon.example.com")).toBe(false);
	});

	test("a manual ws endpoint carries no command — the user already has one", () => {
		const target = createTarget({ id: "m1", label: "Home", url: "wss://daemon.example.com", kind: "manual" });
		expect(targetCommand(target)).toBeNull();
		expect(targetCommand(localTarget())).toBeNull();
	});

	test("a typed localhost row uses the daemon port, not 80, in its command", () => {
		// One rule with `daemonPortOf`: a portless loopback endpoint means the
		// daemon on this machine. Two resolvers used to disagree here, so an ssh
		// row typed as `localhost` produced `-L 80:127.0.0.1:8300`.
		const ssh = createTarget({
			id: "s9",
			label: "Local box",
			url: "ws://localhost",
			kind: "ssh",
			sshHost: "me@example.com",
			remotePort: 8300,
		});
		expect(targetCommand(ssh)).toContain(`${DEFAULT_DAEMON_PORT}:127.0.0.1:8300`);
		expect(targetCommand(ssh)).not.toContain("-L 80:");
		const docker = createTarget({ id: "d9", label: "Box", url: "ws://localhost", kind: "docker", container: "c" });
		expect(targetCommand(docker)).toContain(`--port ${DEFAULT_DAEMON_PORT}`);
		expect(targetCommand(docker)).not.toContain("--port 80");
	});

	test("wsl, ssh and docker rows show the exact command to copy", () => {
		const wsl = createTarget({
			id: "w1",
			label: "Ubuntu",
			url: "ws://127.0.0.1:8300",
			kind: "wsl",
			distro: "Ubuntu-22.04",
		});
		expect(targetCommand(wsl)).toBe("wsl.exe -d Ubuntu-22.04 -- musepi serve --port 8300");

		const ssh = createTarget({
			id: "s1",
			label: "build box",
			url: "ws://127.0.0.1:9400",
			kind: "ssh",
			sshHost: "me@build.example.com",
			remotePort: 8300,
		});
		expect(targetCommand(ssh)).toBe("ssh -N -L 9400:127.0.0.1:8300 me@build.example.com");

		const docker = createTarget({
			id: "d1",
			label: "container",
			url: "ws://127.0.0.1:8300",
			kind: "docker",
			container: "musepi-dev",
		});
		expect(targetCommand(docker)).toBe("docker exec musepi-dev musepi serve --port 8300");
		expect(targetPublishHint(docker)).toBe("docker run -d -p 127.0.0.1:8300:8300 --name musepi-dev musepi");
	});

	test("a command is never invented when its parameter is missing", () => {
		expect(targetCommand(createTarget({ id: "w", label: "w", url: "ws://127.0.0.1:8300", kind: "wsl" }))).toBeNull();
		expect(targetCommand(createTarget({ id: "s", label: "s", url: "ws://127.0.0.1:8300", kind: "ssh" }))).toBeNull();
		expect(
			targetCommand(createTarget({ id: "d", label: "d", url: "ws://127.0.0.1:8300", kind: "docker" })),
		).toBeNull();
	});

	test("upsert keeps list order stable", () => {
		const a = createTarget({ id: "a", label: "A", url: "ws://a:1", kind: "manual" });
		const b = createTarget({ id: "b", label: "B", url: "ws://b:1", kind: "manual" });
		const list = upsertTarget([a, b], { ...a, label: "A2" });
		expect(list.map(row => row.id)).toEqual(["a", "b"]);
		expect(list[0]?.label).toBe("A2");
	});

	test("a legacy row without a kind reads back as manual", () => {
		const legacy = { id: "old", label: "Old host", url: "wss://old.example.com" };
		expect(asTarget(legacy)?.kind).toBe("manual");
		expect(asTarget({ id: "", label: "", url: "" })).toBeNull();
		expect(asTarget("nope")).toBeNull();
	});

	test("boot resolves the chosen target, falling back to the first row", () => {
		const targets = [localTarget(), createTarget({ id: "b", label: "B", url: "ws://b:1", kind: "manual" })];
		expect(bootTarget(targets, "b").id).toBe("b");
		expect(bootTarget(targets, "missing").id).toBe(LOCAL_TARGET_ID);
		expect(bootTarget([], null).kind).toBe("local");
	});

	test("a chosen row whose endpoint did not answer falls back to local on the next launch", () => {
		const wsl = createTarget({ id: "w", label: "Ubuntu", url: "ws://127.0.0.1:8400", kind: "wsl", distro: "Ubuntu" });
		const targets = [localTarget(), wsl];
		const failed = { w: { lastAttemptAt: 1, lastError: "cannot connect to ws://127.0.0.1:8400" } };
		// Boot must not be pinned to an endpoint that stayed silent.
		expect(bootTargetFor(targets, "w", failed).id).toBe(LOCAL_TARGET_ID);
		// The row itself stays listed and chosen for a retry — only boot's start
		// point moves, so nothing the user configured is dropped.
		expect(targets.map(row => row.id)).toEqual([LOCAL_TARGET_ID, "w"]);
		// A manual row is the user's own address and is never silently replaced.
		const manual = createTarget({ id: "m", label: "Home", url: "wss://daemon.example.com", kind: "manual" });
		expect(bootTargetFor([localTarget(), manual], "m", { m: { lastAttemptAt: 1, lastError: "boom" } }).id).toBe("m");
		// After a successful attempt the stored row is booted again.
		expect(bootTargetFor(targets, "w", { w: { lastAttemptAt: 2, lastError: null } }).id).toBe("w");
	});

	test("the token never takes part in matching a connection to its row", () => {
		expect(stripToken("wss://h.example.com:1/?token=s3cret&x=1")).toBe("wss://h.example.com:1/?x=1");
		expect(stripToken("wss://h.example.com:1/?token=s3cret")).toBe("wss://h.example.com:1/");
		expect(stripToken("ws://127.0.0.1:8300")).toBe("ws://127.0.0.1:8300");
	});

	test("a stored endpoint that cannot be parsed names no port, so boot falls back", () => {
		// Boot resolves its first port from a persisted URL. `ftp://nope` has no
		// port and `new URL` refuses the shape outright; neither may throw, or the
		// attempt dies before it can record that it was made.
		expect(daemonPortOf("ws://127.0.0.1:9411")).toBe(9411);
		expect(daemonPortOf("wss://h.example.com")).toBe(443);
		expect(daemonPortOf("ftp://nope")).toBe(DEFAULT_DAEMON_PORT);
		expect(daemonPortOf("not a url at all")).toBe(DEFAULT_DAEMON_PORT);
		expect(daemonPortOf("ftp://nope", 9999)).toBe(9999);
	});

	test("a portless loopback endpoint resolves to the daemon default, not port 80", () => {
		// `normalizeRemoteHostUrl("localhost")` yields `ws://localhost`, and a
		// bare `new URL` port would be 80 — the Electron local probe would then
		// check a port nothing listens on, skip the dial and never spawn.
		expect(daemonPortOf("ws://localhost")).toBe(DEFAULT_DAEMON_PORT);
		expect(daemonPortOf("ws://127.0.0.1")).toBe(DEFAULT_DAEMON_PORT);
		expect(daemonPortOf("ws://[::1]")).toBe(DEFAULT_DAEMON_PORT);
		expect(daemonPortOf("wss://localhost")).toBe(DEFAULT_DAEMON_PORT);
		// An explicit port always wins over the loopback default.
		expect(daemonPortOf("ws://localhost:9411")).toBe(9411);
		// Remote hosts keep the HTTP(S) default: there, 80/443 is the real answer.
		expect(daemonPortOf("ws://h.example.com")).toBe(80);
		expect(daemonPortOf("wss://h.example.com")).toBe(443);
	});
});

describe("target persistence", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	test("a stored list round-trips with its kind parameters intact", () => {
		const target = createTarget({
			id: "w1",
			label: "Ubuntu",
			url: "ws://127.0.0.1:8300",
			kind: "wsl",
			distro: "Ubuntu",
			token: "t0ken",
		});
		saveTargets([localTarget(), target]);
		const loaded = loadTargets();
		expect(loaded.map(row => row.id)).toEqual([LOCAL_TARGET_ID, "w1"]);
		expect(loaded[1]).toMatchObject({ kind: "wsl", distro: "Ubuntu", token: "t0ken" });
	});

	test("loadTargets always yields the local row, even from an empty or corrupt slot", () => {
		expect(loadTargets().map(row => row.id)).toEqual([LOCAL_TARGET_ID]);
		localStorage.setItem("musepi-gui-hosts", "{not json");
		expect(loadTargets().map(row => row.id)).toEqual([LOCAL_TARGET_ID]);
		localStorage.setItem("musepi-gui-hosts", JSON.stringify([{ junk: true }]));
		expect(loadTargets().map(row => row.id)).toEqual([LOCAL_TARGET_ID]);
	});

	test("a legacy host row (no kind) migrates in place as a manual target", () => {
		// The pre-target slot held exactly {id,label,url,token}; nothing is
		// rewritten on read and the row stays usable.
		localStorage.setItem(
			"musepi-gui-hosts",
			JSON.stringify([{ id: "old", label: "Office box", url: "ws://10.0.0.4:8300", token: "abc" }]),
		);
		const stored = loadStoredTargets();
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({ id: "old", kind: "manual", token: "abc" });
		expect(loadTargets().map(row => row.id)).toEqual([LOCAL_TARGET_ID, "old"]);
	});

	test("the chosen target survives a reload and can be cleared", () => {
		expect(loadChosenTargetId()).toBeNull();
		saveChosenTargetId("w1");
		expect(loadChosenTargetId()).toBe("w1");
		saveChosenTargetId(null);
		expect(loadChosenTargetId()).toBeNull();
	});

	test("a failed target stays listed with its error instead of replacing the list", () => {
		let targets = loadTargets();
		const target = createTarget({ id: "bad", label: "Bad", url: "ws://127.0.0.1:9999", kind: "manual" });
		targets = storeTarget(targets, target);
		const statuses = recordTargetStatus(loadTargetStatuses(), "bad", "ECONNREFUSED", 1_700_000_000_000);
		saveTargetStatuses(statuses);

		// Re-reading both slots is what a restart does.
		const reloadedTargets = loadTargets();
		const reloadedStatuses = loadTargetStatuses();
		expect(reloadedTargets.some(row => row.id === "bad")).toBe(true);
		expect(reloadedStatuses.bad).toEqual({ lastAttemptAt: 1_700_000_000_000, lastError: "ECONNREFUSED" });
	});

	test("dropping a target removes its row and its status, and never the local row", () => {
		let targets = storeTarget(loadTargets(), createTarget({ id: "x", label: "X", url: "ws://x:1", kind: "manual" }));
		saveTargetStatuses(recordTargetStatus({}, "x", "boom"));
		targets = dropTarget(targets, "x");
		expect(targets.some(row => row.id === "x")).toBe(false);
		expect(loadTargetStatuses().x).toBeUndefined();
		expect(dropTarget(targets, LOCAL_TARGET_ID).some(row => row.id === LOCAL_TARGET_ID)).toBe(true);
	});
});

describe("WSL detection", () => {
	const runner =
		(output: string | null): WslRunner =>
		async () =>
			output;

	test("zero distributions is a real answer, not a failure", async () => {
		const result = await detectWsl(runner(""));
		expect(result).toEqual({ status: "ok", distros: [] });
	});

	test("two distributions parse with the default marked", async () => {
		const result = await detectWsl(runner("Ubuntu-22.04\r\nDebian\r\n"));
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.distros).toEqual([
			{ name: "Ubuntu-22.04", isDefault: true },
			{ name: "Debian", isDefault: false },
		]);
	});

	test("a failed probe is unavailable, distinct from an empty list", async () => {
		const result = await detectWsl(async () => {
			throw new Error("wsl.exe not found");
		});
		expect(result).toEqual({ status: "unavailable", error: "wsl.exe not found" });
	});

	test("no bridge at all is unsupported", async () => {
		expect(await detectWsl(runner(null))).toEqual({ status: "unsupported" });
	});

	test("UTF-16 output decoded as Latin-1 still parses", () => {
		// Real `wsl.exe -l -q` output is often UTF-16LE; a byte-oriented reader
		// yields the interleaved-NUL form.
		const utf16 = "U\u0000b\u0000u\u0000n\u0000t\u0000u\u0000\r\u0000\n\u0000";
		expect(parseWslDistroList(utf16)).toEqual([{ name: "Ubuntu", isDefault: true }]);
	});

	test("`-v` style markers and a header row never become distributions", () => {
		const output =
			"  NAME      STATE           VERSION\n* Ubuntu    Running         2\n  Debian    Stopped         2\n";
		expect(parseWslDistroList(output)).toEqual([
			{ name: "Ubuntu", isDefault: true },
			{ name: "Debian", isDefault: false },
		]);
	});

	test("the (Default) marker is stripped from the name", () => {
		expect(parseWslDistroList("Ubuntu (Default)\r\nAlpine\r\n")).toEqual([
			{ name: "Ubuntu", isDefault: true },
			{ name: "Alpine", isDefault: false },
		]);
	});
});
