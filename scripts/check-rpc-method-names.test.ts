import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	clientMethods,
	declaredMethods,
	dispatchedRoutes,
	methodLiterals,
	unroutedMethods,
} from "./check-rpc-method-names";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeFile(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

/** A tree with both dispatchers and one client file, so the gate can be tested end to end. */
function fixture(clientSource: string, hostRoutes: string[] = [], requiredMethods: string[] = []): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-method-names-"));
	dirs.push(root);
	writeFile(
		path.join(root, "packages/coding-agent/src/daemon/server.ts"),
		`export class Server {
	async handle(method: string, params: unknown): Promise<unknown> {
		switch (method) {
			case "session.setModel":
				return params;
			case "providers.loginInput":
			case "providers.loginCancel":
			case "providers.logout":
			case "models.add": {
				switch (params as string) {
					case "nested-only":
						return null;
				}
				return null;
			}
			default:
				throw new Error("unknown method");
		}
	}
}
`,
	);
	writeFile(
		path.join(root, "packages/coding-agent/src/collab/host.ts"),
		`export class Host {
	async #rpcDispatch(method: string): Promise<unknown> {
		switch (method) {
${hostRoutes.map(route => `			case "${route}":`).join("\n") || '			case "ping":'}
				return null;
			default:
				throw new Error("unknown");
		}
	}
}
`,
	);
	writeFile(path.join(root, "apps/desktop/src/components/Calls.tsx"), clientSource);
	writeFile(
		path.join(root, "apps/desktop/src/lib/daemon-version.ts"),
		`/** Methods the GUI probes before trusting the daemon. */
export const REQUIRED_DAEMON_METHODS: readonly string[] = [
${requiredMethods.map(route => `	"${route}",`).join("\n")}
];
`,
	);
	return root;
}

function runGate(root: string): { code: number; stdout: string; stderr: string } {
	const result = Bun.spawnSync({
		cmd: ["bun", path.join(REPO_ROOT, "scripts", "check-rpc-method-names.ts")],
		cwd: root,
		env: { ...process.env, RPC_METHOD_ROOT: root },
	});
	return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe("methodLiterals", () => {
	test("reads a lone literal and unwraps parentheses", () => {
		expect(methodLiterals('"session.setModel"')).toEqual(["session.setModel"]);
		expect(methodLiterals("('models.add')")).toEqual(["models.add"]);
	});

	test("reads both arms of a selector and ignores its condition", () => {
		expect(methodLiterals('action === "install" ? "marketplace.install" : "marketplace.remove"')).toEqual([
			"marketplace.install",
			"marketplace.remove",
		]);
	});

	test("does not read ?? or ?. as a conditional", () => {
		expect(methodLiterals('value ?? "session.setModel"')).toEqual([]);
		expect(methodLiterals("host?.method")).toEqual([]);
	});
});

describe("check-rpc-method-names", () => {
	test("flags the i18n-rewrite damage samples and nothing else", () => {
		const root = fixture(`
const calls = [
  rpc.request("settings.sessionSetmodel", {}),
  rpc.request("settings.providersLogininput", {}),
  rpc.request(action === "install" ? "settings.providersLogincancel" : "providers.loginCancel", {}),
  rpc.rpc("settings.providersLogout", {}),
  rpc.request("settings.modelsAdd", {}),
  rpc.request("session.setModel", {}),
];
`);
		expect(unroutedMethods(root).map(entry => entry.method)).toEqual([
			"settings.modelsAdd",
			"settings.providersLogincancel",
			"settings.providersLogininput",
			"settings.providersLogout",
			"settings.sessionSetmodel",
		]);
	});

	test("reports the call site of every miss", () => {
		const root = fixture(`const x = rpc.request("settings.sessionSetmodel", {});`);
		expect(unroutedMethods(root)).toEqual([
			{ method: "settings.sessionSetmodel", places: ["apps/desktop/src/components/Calls.tsx:1"] },
		]);
	});

	test("reads a hoisted local selector", () => {
		const root = fixture(`
const method = isStream ? "models.list" : "models.add";
rpc.request(method, {});
`);
		expect(unroutedMethods(root).map(entry => entry.method)).toEqual(["models.list"]);
	});

	test("ignores nested switch labels inside a case body", () => {
		const root = fixture(`rpc.request("nested-only", {});`);
		expect(unroutedMethods(root).map(entry => entry.method)).toEqual(["nested-only"]);
	});

	test("accepts a route only the collab host answers", () => {
		const root = fixture(`client.rpc("workspace.tree", {});`, ["workspace.tree"]);
		expect(unroutedMethods(root)).toEqual([]);
		expect(clientMethods(root).has("workspace.tree")).toBe(true);
	});

	test("scans the bundled plugin panels", () => {
		const root = fixture(`rpc.request("session.setModel", {});`);
		writeFile(
			path.join(root, "packages/coding-agent/src/plugins/demo/ui/panel.tsx"),
			`host.request("settings.sessionSetmodel", {});`,
		);
		expect(unroutedMethods(root).map(entry => entry.method)).toEqual(["settings.sessionSetmodel"]);
	});

	test("flags a misspelt route in the daemon probe list", () => {
		const root = fixture(
			`rpc.request("session.setModel", {});`,
			[],
			["skills.marketplace.query", "settings.sessionSetmodel"],
		);
		const [miss] = unroutedMethods(root);
		expect(miss?.method).toBe("settings.sessionSetmodel");
		expect(miss?.places[0]).toContain("apps/desktop/src/lib/daemon-version.ts");
		expect(miss?.places[0]).toContain("REQUIRED_DAEMON_METHODS");
	});

	test("does not read quoted words from the probe list's comments", () => {
		const root = fixture(`rpc.request("session.setModel", {});`);
		writeFile(
			path.join(root, "apps/desktop/src/lib/daemon-version.ts"),
			`export const REQUIRED_DAEMON_METHODS: readonly string[] = [
	// the daemon answered "not-a-route" in a comment
	"session.setModel",
];
`,
		);
		expect(unroutedMethods(root)).toEqual([]);
	});

	test("every route the GUI requires is a real dispatcher route", () => {
		const routes = dispatchedRoutes(REPO_ROOT);
		for (const method of declaredMethods(REPO_ROOT).keys()) expect(routes.has(method)).toBe(true);
	});

	test("fails the CLI with the offending name and place", () => {
		const root = fixture(`rpc.request("settings.sessionSetmodel", {});`);
		const result = runGate(root);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("settings.sessionSetmodel");
		expect(result.stderr).toContain("apps/desktop/src/components/Calls.tsx:1");
	});

	test("passes on the current tree — the gate's own regression", () => {
		expect(unroutedMethods(REPO_ROOT)).toEqual([]);
		expect(runGate(REPO_ROOT).code).toBe(0);
	});

	test("every flow route is a real dispatcher route", () => {
		const routes = dispatchedRoutes(REPO_ROOT);
		for (const route of [
			"session.setModel",
			"providers.loginInput",
			"providers.loginCancel",
			"providers.logout",
			"models.add",
		]) {
			expect(routes.has(route)).toBe(true);
		}
	});
});
