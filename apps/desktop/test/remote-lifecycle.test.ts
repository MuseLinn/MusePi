import { describe, expect, test } from "bun:test";
import {
	applyTargetStatus,
	loadHostCatalog,
	type ManagedTargetStatus,
	managedFailureText,
	managedRowState,
	managedStartBlocker,
	pruneTargetStatuses,
	type ShellBridge,
	targetFromCatalogHost,
	tunnelPreview,
} from "../src/lib/connection/remote-lifecycle";
import {
	catalogEntryFor,
	hostDestination,
	mergeHostCatalog,
	parseSshConfig,
	type SshConfigHost,
} from "../src/lib/connection/ssh-config";
import { createTarget, targetCommand } from "../src/lib/connection/targets";

const doc = (text: string, path = "~/.ssh/config") => ({ path, text });

describe("~/.ssh/config parsing", () => {
	test("a host block carries its name, destination, user, port and key", () => {
		const hosts = parseSshConfig([
			doc(`Host build
  HostName build.example.com
  User me
  Port 2222
  IdentityFile ~/.ssh/id_ed25519
`),
		]);
		expect(hosts).toEqual([
			{
				name: "build",
				host: "build.example.com",
				username: "me",
				port: 2222,
				keyPath: "~/.ssh/id_ed25519",
			},
		]);
	});

	test("an alias without HostName dials its own name", () => {
		expect(parseSshConfig([doc("Host nas\n  User root\n")])).toEqual([
			{ name: "nas", host: "nas", username: "root" },
		]);
	});

	test("directives before the first Host are defaults for every block", () => {
		const hosts = parseSshConfig([
			doc(`User default-user
Port 2200
IdentityFile ~/.ssh/default_key
Host a
  HostName a.example.com
Host b
  HostName b.example.com
  User override
`),
		]);
		expect(hosts).toEqual([
			{
				name: "a",
				host: "a.example.com",
				username: "default-user",
				port: 2200,
				keyPath: "~/.ssh/default_key",
			},
			{
				name: "b",
				host: "b.example.com",
				username: "override",
				port: 2200,
				keyPath: "~/.ssh/default_key",
			},
		]);
	});

	test("one Host line can name several aliases", () => {
		const hosts = parseSshConfig([doc("Host a b c\n  HostName shared.example.com\n")]);
		expect(hosts.map(host => host.name)).toEqual(["a", "b", "c"]);
	});

	test("a ProxyJump chain is preserved verbatim", () => {
		const hosts = parseSshConfig([doc("Host internal\n  HostName 10.0.0.5\n  ProxyJump bastion\n")]);
		expect(hosts[0]?.proxyJump).toBe("bastion");
		const chain = parseSshConfig([doc("Host deep\n  HostName 10.0.0.9\n  ProxyJump a,b\n")]);
		expect(chain[0]?.proxyJump).toBe("a,b");
	});

	test("wildcard and negated patterns never become rows", () => {
		const hosts = parseSshConfig([
			doc(`Host *.corp.example.com
  User nobody
Host !excluded other
  HostName real.example.com
Host plain
  HostName plain.example.com
`),
		]);
		// A wildcard has no single address, so it is not a row. `!excluded other`
		// is a *negated* matcher beside one concrete alias, and OpenSSH reads it
		// as "everywhere except excluded" — the concrete alias is still one host,
		// so it keeps its row and the negation itself never becomes one.
		expect(hosts.map(host => host.name)).toEqual(["other", "plain"]);
		expect(hosts.every(host => !host.name.startsWith("!"))).toBe(true);
	});

	test("comments, blank lines, `=` syntax and mixed case are tolerated", () => {
		const hosts = parseSshConfig([
			doc(`# a comment
host=build
  HOSTNAME = build.example.com   # trailing comment
  user = me
`),
		]);
		expect(hosts).toEqual([{ name: "build", host: "build.example.com", username: "me" }]);
	});

	test("an unknown keyword costs nothing", () => {
		const hosts = parseSshConfig([
			doc(`Host build
  HostName build.example.com
  ForwardAgent yes
  ServerAliveInterval 30
`),
		]);
		expect(hosts).toHaveLength(1);
	});

	test("a malformed or absent config is empty rather than fatal", () => {
		expect(parseSshConfig([])).toEqual([]);
		expect(parseSshConfig([doc("")])).toEqual([]);
		expect(parseSshConfig([doc("Host\nHostName\nPort not-a-number\n")])).toEqual([]);
		// A block with a bad port keeps the host and drops the unusable field.
		expect(parseSshConfig([doc("Host a\n  HostName a.example.com\n  Port banana\n")])).toEqual([
			{ name: "a", host: "a.example.com" },
		]);
	});

	test("a later duplicate alias keeps the first block's facts", () => {
		// OpenSSH itself uses the first value it obtains for a parameter, so a
		// second block for the same alias must not silently rewrite the row.
		const hosts = parseSshConfig([
			doc(`Host build
  HostName first.example.com
Host build
  HostName second.example.com
`),
		]);
		expect(hosts).toEqual([{ name: "build", host: "first.example.com" }]);
	});
});

describe("catalog merge precedence", () => {
	const musepi: SshConfigHost[] = [{ name: "build", host: "musepi.example.com", username: "musepi-user" }];
	const fromConfig: SshConfigHost[] = [
		{ name: "build", host: "config.example.com", username: "config-user" },
		{ name: "nas", host: "nas.local" },
	];

	test("MusePi's own entry wins a name collision", () => {
		const merged = mergeHostCatalog(musepi, fromConfig);
		const build = merged.find(entry => entry.name === "build");
		expect(build).toMatchObject({ host: "musepi.example.com", username: "musepi-user", source: "musepi" });
	});

	test("ssh config fills every name MusePi does not have", () => {
		const merged = mergeHostCatalog(musepi, fromConfig);
		expect(merged.map(entry => entry.name)).toEqual(["build", "nas"]);
		expect(merged.find(entry => entry.name === "nas")).toMatchObject({ source: "ssh-config", host: "nas.local" });
	});

	test("the winning MusePi entry borrows a chain it lacks from the shadowed entry", () => {
		// "MusePi wins" is about the row's identity, not about its absent fields
		// erasing the other source. Before this, a host recorded in both with the
		// chain only in ~/.ssh/config was downgraded to a direct dial.
		const merged = mergeHostCatalog(
			[{ name: "internal", host: "10.0.0.5", username: "me" }],
			[{ name: "internal", host: "10.0.0.5", proxyJump: "bastion", keyPath: "~/.ssh/id_ed25519" }],
		);
		expect(merged).toHaveLength(1);
		expect(merged[0]).toMatchObject({
			source: "musepi",
			username: "me",
			proxyJump: "bastion",
			keyPath: "~/.ssh/id_ed25519",
		});
	});

	test("a MusePi entry with its own chain keeps it, not the shadowed one", () => {
		const merged = mergeHostCatalog(
			[{ name: "h", host: "a", proxyJump: "mine", keyPath: "~/.ssh/mine" }],
			[{ name: "h", host: "a", proxyJump: "theirs", keyPath: "~/.ssh/theirs" }],
		);
		expect(merged[0]).toMatchObject({ proxyJump: "mine", keyPath: "~/.ssh/mine" });
	});

	test("the MusePi host and user still win the collision", () => {
		const merged = mergeHostCatalog(
			[{ name: "h", host: "musepi.example.com", username: "musepi-user" }],
			[{ name: "h", host: "config.example.com", username: "config-user", proxyJump: "bastion" }],
		);
		expect(merged[0]).toMatchObject({
			host: "musepi.example.com",
			username: "musepi-user",
			proxyJump: "bastion",
		});
	});

	test("no name appears twice, whatever the inputs", () => {
		const merged = mergeHostCatalog(
			[
				{ name: "dup", host: "one" },
				{ name: "dup", host: "two" },
			],
			[
				{ name: "dup", host: "three" },
				{ name: "dup", host: "four" },
			],
		);
		expect(merged).toHaveLength(1);
		expect(merged[0]).toMatchObject({ host: "one", source: "musepi" });
	});

	test("a host is found by alias or by the destination a row stored", () => {
		const catalog = mergeHostCatalog([], [{ name: "build", host: "build.example.com", username: "me" }]);
		const byAlias = createTarget({ id: "a", label: "a", url: "ws://127.0.0.1:8300", kind: "ssh", sshHost: "build" });
		const byDestination = createTarget({
			id: "b",
			label: "b",
			url: "ws://127.0.0.1:8300",
			kind: "ssh",
			sshHost: "me@build.example.com",
		});
		expect(catalogEntryFor(byAlias, catalog)?.name).toBe("build");
		expect(catalogEntryFor(byDestination, catalog)?.name).toBe("build");
		expect(hostDestination(catalog[0]!)).toBe("me@build.example.com");
	});
});

describe("the one catalog both surfaces read", () => {
	const bridge = (payload: Awaited<ReturnType<NonNullable<ShellBridge["sshConfig"]>>>): ShellBridge => ({
		sshConfig: async () => payload,
	});

	test("an ssh-config-only host appears beside the MusePi ones", async () => {
		const catalog = await loadHostCatalog(
			bridge({
				ok: true,
				documents: [doc("Host fromConfigOnly\n  HostName only.example.com\n")],
				musepi: [{ name: "managed", host: "managed.example.com" }],
			}),
		);
		expect(catalog.map(entry => entry.name)).toEqual(["managed", "fromConfigOnly"]);
	});

	test("a collision resolves by the stated precedence through the loader too", async () => {
		const catalog = await loadHostCatalog(
			bridge({
				ok: true,
				documents: [doc("Host build\n  HostName config.example.com\n")],
				musepi: [{ name: "build", host: "musepi.example.com" }],
			}),
		);
		expect(catalog).toEqual([{ name: "build", host: "musepi.example.com", source: "musepi" }]);
	});

	test("no bridge, a throwing bridge or a malformed payload is an empty catalog", async () => {
		expect(await loadHostCatalog(null)).toEqual([]);
		expect(
			await loadHostCatalog({
				sshConfig: async () => {
					throw new Error("bridge gone");
				},
			}),
		).toEqual([]);
		expect(await loadHostCatalog(bridge({ ok: false, documents: [] }))).toEqual([]);
	});

	test("a catalog host becomes an ssh row whose command carries its ProxyJump", () => {
		const row = targetFromCatalogHost(
			{
				name: "internal",
				host: "10.0.0.5",
				username: "me",
				port: 2222,
				proxyJump: "bastion",
				keyPath: "~/.ssh/id_ed25519",
				source: "ssh-config",
			},
			8300,
		);
		expect(row).toMatchObject({
			kind: "ssh",
			sshHost: "me@10.0.0.5",
			sshPort: 2222,
			proxyJump: "bastion",
			keyPath: "~/.ssh/id_ed25519",
		});
		const command = targetCommand({ ...row });
		expect(command).toBe("ssh -N -p 2222 -i ~/.ssh/id_ed25519 -J bastion -L 8300:127.0.0.1:8300 me@10.0.0.5");
	});
});

describe("managed row decisions", () => {
	const status = (over: Partial<ManagedTargetStatus> = {}): ManagedTargetStatus => ({
		targetId: "t",
		kind: "ssh",
		status: "running",
		pid: 42,
		startedAt: 1,
		listeningPort: 8300,
		error: null,
		stderr: "",
		command: "ssh -N …",
		...over,
	});

	test("a stopped process reads idle, never failed", () => {
		// A user who pressed 停止 got what they asked for; showing an error for
		// it would make an intentional action look like a fault.
		expect(managedRowState(status({ status: "stopped" }))).toBe("idle");
		expect(managedRowState(undefined)).toBe("idle");
		expect(managedRowState(status({ status: "connecting" }))).toBe("starting");
		expect(managedRowState(status({ status: "running" }))).toBe("running");
		expect(managedRowState(status({ status: "failed" }))).toBe("failed");
	});

	test("the failure text is the process's own stderr, with the summary only as a fallback", () => {
		expect(managedFailureText(status({ status: "failed", stderr: "Permission denied (publickey)." }))).toBe(
			"Permission denied (publickey).",
		);
		expect(managedFailureText(status({ status: "failed", stderr: "  ", error: "ssh exited with code 255" }))).toBe(
			"ssh exited with code 255",
		);
		expect(managedFailureText(status({ status: "failed", stderr: "", error: null }))).toBeNull();
		expect(managedFailureText(status({ status: "running" }))).toBeNull();
	});

	test("only a forwarded kind with its parameter can be managed", () => {
		const ssh = createTarget({ id: "s", label: "s", url: "ws://127.0.0.1:8300", kind: "ssh", sshHost: "h" });
		expect(managedStartBlocker(ssh, "darwin")).toBeNull();
		expect(managedStartBlocker({ ...ssh, sshHost: undefined }, "darwin")).toBe("missing-host");
		const wsl = createTarget({ id: "w", label: "w", url: "ws://127.0.0.1:8300", kind: "wsl", distro: "Ubuntu" });
		expect(managedStartBlocker(wsl, "win32")).toBeNull();
		expect(managedStartBlocker(wsl, "darwin")).toBe("not-this-platform");
		expect(managedStartBlocker({ ...wsl, distro: undefined }, "win32")).toBe("missing-distro");
		const manual = createTarget({ id: "m", label: "m", url: "wss://h", kind: "manual" });
		expect(managedStartBlocker(manual, "darwin")).toBe("not-managed-kind");
	});

	test("statuses merge per target and are pruned with their row", () => {
		const one = applyTargetStatus({}, status({ targetId: "a" }));
		const two = applyTargetStatus(one, status({ targetId: "b" }));
		expect(Object.keys(two).sort()).toEqual(["a", "b"]);
		const targets = [createTarget({ id: "a", label: "a", url: "ws://a", kind: "manual" })];
		expect(Object.keys(pruneTargetStatuses(two, targets))).toEqual(["a"]);
	});

	test("the tunnel preview is the argv the supervisor builds", () => {
		expect(tunnelPreview({ localPort: 9400, remotePort: 8300, destination: "me@h", proxyJump: "bastion" })).toBe(
			"ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -J bastion -L 9400:127.0.0.1:8300 me@h",
		);
	});
});
