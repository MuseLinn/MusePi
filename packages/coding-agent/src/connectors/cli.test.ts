import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	checkCliVersion,
	parseCliAuthOutput,
	planSpawn,
	runCliLogout,
	runCliStatus,
	startCliAuth,
	tokenizeCommand,
} from "./cli";
import type { ConnectorCliSpec } from "./types";

const dirs: string[] = [];
const started: Array<Awaited<ReturnType<typeof startCliAuth>>["process"]> = [];

async function fixture(): Promise<{ spec: ConnectorCliSpec; stateFile: string; dir: string }> {
	const dir = await fs.mkdtemp(path.join(tmpdir(), "musepi-cli-"));
	dirs.push(dir);
	const script = path.join(dir, "fake-cli.mjs");
	const stateFile = path.join(dir, "logged-in");
	await fs.writeFile(
		script,
		`import fs from "node:fs";
const [cmd, state] = process.argv.slice(2);
if (cmd === "--version") console.log("1.2.3");
else if (cmd === "auth") {
  fs.writeFileSync(state, "1");
  console.log("Open https://example.com/device");
  console.log("code: ABCD-1234");
  setTimeout(() => {}, 30000);
} else if (cmd === "status") {
  console.log(fs.existsSync(state) ? "Logged in" : "Not logged in");
} else if (cmd === "logout") {
  try { fs.unlinkSync(state); } catch {}
}
`,
		"utf8",
	);
	const run = (args: string): string => `"${process.execPath}" "${script}" ${args}`;
	const spec: ConnectorCliSpec = {
		versionCheck: { command: run(`--version "${stateFile}"`), minVersion: "1.0.0" },
		auth: {
			darwin: run(`auth "${stateFile}"`),
			linux: run(`auth "${stateFile}"`),
			win32: run(`auth "${stateFile}"`),
		},
		status: {
			darwin: run(`status "${stateFile}"`),
			linux: run(`status "${stateFile}"`),
			win32: run(`status "${stateFile}"`),
		},
		unAuth: {
			darwin: run(`logout "${stateFile}"`),
			linux: run(`logout "${stateFile}"`),
			win32: run(`logout "${stateFile}"`),
		},
		statusMatch: "Logged in",
	};
	return { spec, stateFile, dir };
}

afterEach(async () => {
	for (const process of started.splice(0)) process.kill();
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe("managed CLI runtime", () => {
	it("tokenizes quoted command lines without a shell", () => {
		expect(tokenizeCommand(`"C:\\Program Files\\node.exe" --version`)).toEqual([
			"C:\\Program Files\\node.exe",
			"--version",
		]);
		expect(tokenizeCommand(`echo "a b" 'c d'`)).toEqual(["echo", "a b", "c d"]);
		expect(tokenizeCommand(`a && b`)).toEqual(["a", "&&", "b"]);
	});

	it("extracts a preferred URL and device code", () => {
		const parsed = parseCliAuthOutput(
			"Open https://other.example/x and https://meeting.tencent.com/device\ncode: ABCD-1234",
			"meeting.tencent.com",
		);
		expect(parsed.authorizationUrl).toBe("https://meeting.tencent.com/device");
		expect(parsed.userCode).toBe("ABCD-1234");
	});

	it("checks the declared version", async () => {
		const { spec } = await fixture();
		const result = await checkCliVersion(spec);
		expect(result).toEqual({ installed: true, version: "1.2.3", needsUpgrade: false });
	});

	it("starts auth, reports the code, and completes through status", async () => {
		const { spec, stateFile } = await fixture();
		const auth = await startCliAuth(spec);
		started.push(auth.process);
		expect(auth.authorizationUrl).toBe("https://example.com/device");
		expect(auth.userCode).toBe("ABCD-1234");
		expect(await fs.readFile(stateFile, "utf8")).toBe("1");

		expect(await runCliStatus(spec)).toMatchObject({ loggedIn: true });
		await runCliLogout(spec);
		expect(await runCliStatus(spec)).toMatchObject({ loggedIn: false });
	});

	it("routes Windows batch shims through cmd.exe", async () => {
		if (process.platform !== "win32") return;
		const root = await fs.mkdtemp(path.join(tmpdir(), "musepi-cli-shim-"));
		dirs.push(root);
		// A space forces cmd quoting, which is the case that breaks naive spawns.
		const dir = path.join(root, "with space");
		await fs.mkdir(dir);
		const shimFile = path.join(dir, "tool.cmd");
		await fs.writeFile(shimFile, "@echo off\r\necho hi\r\n", "utf8");

		const shim = planSpawn(["tool", "arg"], dir);
		expect(shim.verbatim).toBe(true);
		expect(path.basename(shim.argv[0] ?? "").toLowerCase()).toBe("cmd.exe");
		expect(shim.argv.slice(1, 4)).toEqual(["/d", "/s", "/c"]);
		expect(shim.argv.at(-1)).toBe(`""${shimFile}" arg"`);

		// An explicit executable is launched directly; no shell is involved.
		const direct = planSpawn(["node", "--version"], dir);
		expect(direct.verbatim).toBe(false);
		expect(direct.argv.at(-1)).toBe("--version");
	});
});
