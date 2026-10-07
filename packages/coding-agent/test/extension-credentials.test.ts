/**
 * pi.credentials 运行时消费契约：
 * 1. 扩展能存/取/列/删自己的密文槽位，OAuth 字段原样往返。
 * 2. 未设置的槽位读到 `null` 而非空凭证——「还没登录」必须与「凭证是空的」可区分。
 * 3. **两个扩展互相看不见对方的槽位**：命名空间由宿主注入，扩展只传槽名。
 * 4. 命名空间取自扩展名而非安装路径——同一扩展换目录安装后仍能读到原凭证。
 * 5. `health` 报告的是「存储可用」而非「槽位为空」。
 *
 * 失败模式：扩展 A 覆盖扩展 B 的密钥；用户重装插件后登录态静默消失；扩展把
 * 未登录读成已登录并发出了一个空 Bearer。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadExtensions } from "../src/extensibility/extensions/loader";
import { resetPluginCredentialManager } from "../src/plugin-credentials";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "./helpers/isolate-agent-dir";

let probeOut = "";

/** One extension that dumps whatever the probe body makes it record. */
async function writeFixture(root: string, name: string, body: string): Promise<string> {
	const dir = path.join(root, "extensions", name);
	await fs.mkdir(dir, { recursive: true });
	await Bun.write(path.join(dir, "package.json"), JSON.stringify({ name, musepi: { extensions: ["index.ts"] } }));
	await Bun.write(
		path.join(dir, "index.ts"),
		`export default async function (pi: any): Promise<void> {
			const record = async (fn: () => Promise<unknown>): Promise<void> => {
				try { await Bun.write(process.env.PROBE_OUT!, JSON.stringify({ ok: await fn() })); }
				catch (err) { await Bun.write(process.env.PROBE_OUT!, JSON.stringify({ error: String(err) })); }
			};
			${body}
		}\n`,
	);
	return path.join(dir, "index.ts");
}

async function run(entry: string, cwd: string): Promise<Record<string, unknown>> {
	const result = await loadExtensions([entry], cwd);
	expect(result.errors).toEqual([]);
	return JSON.parse(await Bun.file(probeOut).text()) as Record<string, unknown>;
}

describe("pi.credentials 扩展密文槽位", () => {
	let isolatedDir: string;
	let cwd: string;

	beforeAll(async () => {
		isolatedDir = await isolateAgentDirForTest("ext-cred-");
		cwd = isolatedDir;
	});

	afterAll(async () => {
		await restoreAgentDirForTest(isolatedDir);
	}, 30000);

	beforeEach(async () => {
		resetPluginCredentialManager();
		probeOut = path.join(cwd, `probe-${Math.random().toString(36).slice(2)}.json`);
		process.env.PROBE_OUT = probeOut;
	});

	test("round-trips a secret with its OAuth fields", async () => {
		const entry = await writeFixture(
			cwd,
			"cred-roundtrip",
			`await pi.credentials.set("upstream", {
				value: "access-1", refreshToken: "refresh-1", expiresAt: 1893456000000,
				clientId: "cid", clientSecret: "csecret", metadata: { account: "a-1" },
			});
			await record(async () => pi.credentials.get("upstream"));`,
		);
		expect(await run(entry, cwd)).toEqual({
			ok: {
				value: "access-1",
				refreshToken: "refresh-1",
				expiresAt: 1893456000000,
				clientId: "cid",
				clientSecret: "csecret",
				metadata: { account: "a-1" },
			},
		});
	});

	test("an unset slot reads as null rather than a blank credential", async () => {
		// The two are different states: "this extension has never been logged in"
		// versus "an account exists but its secret is blank". Only the first may
		// be answered with a login prompt; the second is a corrupt record.
		const entry = await writeFixture(
			cwd,
			"cred-unset",
			`await record(async () => await pi.credentials.get("never-written"));`,
		);
		expect(await run(entry, cwd)).toEqual({ ok: null });
	});

	test("lists and deletes only its own slots", async () => {
		const entry = await writeFixture(
			cwd,
			"cred-list",
			`await pi.credentials.set("one", { value: "1" });
			await pi.credentials.set("two", { value: "2" });
			const before = (await pi.credentials.list()).sort();
			const deleted = await pi.credentials.delete("one");
			const after = (await pi.credentials.list()).sort();
			await record(async () => ({ before, deleted, after, gone: await pi.credentials.get("one") }));`,
		);
		expect(await run(entry, cwd)).toEqual({
			ok: { before: ["one", "two"], deleted: true, after: ["two"], gone: null },
		});
	});

	test("deleting a slot that was never written reports false", async () => {
		// "Already gone" and "gone" are the same end state but not the same
		// answer: the first means the caller asked twice, the second means it
		// removed something.
		const entry = await writeFixture(
			cwd,
			"cred-delete-missing",
			`await record(async () => await pi.credentials.delete("never-existed"));`,
		);
		expect(await run(entry, cwd)).toEqual({ ok: false });
	});

	test("one extension cannot read or list another extension's slots", async () => {
		// The namespace is supplied by the host and the extension only ever passes
		// a slot name, so there is no id for it to forge. Without that, any
		// extension could enumerate the whole store.
		const first = await writeFixture(
			cwd,
			"cred-alpha",
			`await pi.credentials.set("shared-name", { value: "alpha-secret" });
			await record(async () => "written");`,
		);
		expect(await run(first, cwd)).toEqual({ ok: "written" });
		await fs.writeFile(probeOut, "");

		const second = await writeFixture(
			cwd,
			"cred-beta",
			`await record(async () => ({
				sameSlotName: await pi.credentials.get("shared-name"),
				listed: await pi.credentials.list(),
			}));`,
		);
		expect(await run(second, cwd)).toEqual({ ok: { sameSlotName: null, listed: [] } });
	});

	test("a credential survives the extension being reinstalled elsewhere", async () => {
		// The namespace is the extension's name, not the directory it sits in.
		// A path-derived key would hand back an empty store after a move, and the
		// person would have to log in again with nothing saying why.
		const first = await writeFixture(
			cwd,
			"cred-portable",
			`await pi.credentials.set("upstream", { value: "survives-move" });
			await record(async () => "written");`,
		);
		expect(await run(first, cwd)).toEqual({ ok: "written" });
		await fs.writeFile(probeOut, "");

		// Same package name, different install location — the shape of a reinstall
		// into another plugins root, or a move between a project and the user
		// scope. The directory is renamed on the way, which is why the package
		// name rather than the path has to be the namespace.
		const movedDir = path.join(cwd, "elsewhere", "installed-under-another-dir");
		await fs.mkdir(movedDir, { recursive: true });
		await Bun.write(
			path.join(movedDir, "package.json"),
			JSON.stringify({ name: "cred-portable", musepi: { extensions: ["index.ts"] } }),
		);
		await Bun.write(
			path.join(movedDir, "index.ts"),
			`export default async function (pi: any): Promise<void> {
				await Bun.write(process.env.PROBE_OUT!, JSON.stringify({ ok: await pi.credentials.get("upstream") }));
			}\n`,
		);
		expect(await run(path.join(movedDir, "index.ts"), cwd)).toEqual({ ok: { value: "survives-move" } });
	});

	test("reports store health separately from whether a slot is filled", async () => {
		// A store that cannot be written to makes every later set fail, and a
		// caller should learn that before it tries to log someone in.
		const entry = await writeFixture(
			cwd,
			"cred-health",
			`await record(async () => ({ health: await pi.credentials.health(), unset: await pi.credentials.get("x") }));`,
		);
		const result = await run(entry, cwd);
		expect(result.ok).toMatchObject({ unset: null });
		expect((result.ok as { health: { healthy: boolean } }).health.healthy).toBe(true);
	});
});
