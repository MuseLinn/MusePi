import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CordisDynamicPluginRuntime } from "../src/daemon/cordis-dynamic-plugins";
import { DaemonHostContext } from "../src/daemon/host-context";

let root = "";
let host: DaemonHostContext;
let runtime: CordisDynamicPluginRuntime;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-profile-hmr-"));
	host = new DaemonHostContext();
	runtime = new CordisDynamicPluginRuntime(host);
});

afterEach(async () => {
	await runtime.dispose();
	await host.dispose();
	await fs.rm(root, { recursive: true, force: true });
});

async function writePlugin(name: string, command: string, shared = false): Promise<string> {
	const dir = path.join(root, name);
	await fs.mkdir(dir, { recursive: true });
	const value = shared ? "sharedValue()" : `"${name}-v1"`;
	await fs.writeFile(
		path.join(dir, "package.json"),
		JSON.stringify({
			name,
			version: "0.0.0",
			musepi: { extensions: ["./index.ts"] },
		}),
	);
	const importShared = shared ? 'import { sharedValue } from "../shared";\n' : "";
	await fs.writeFile(
		path.join(dir, "index.ts"),
		`${importShared}export default function (pi: any) {\n	pi.registerCommand("${command}", { handler: async () => ${value} });\n	pi.registerCommand("${command}-count", { handler: async () => String((globalThis as any)[${JSON.stringify(command)}] = ((globalThis as any)[${JSON.stringify(command)}] ?? 0) + 1) });\n}\n`,
	);
	return dir;
}

async function writeShared(value: string): Promise<void> {
	await fs.writeFile(
		path.join(root, "shared.ts"),
		`export function sharedValue() { return ${JSON.stringify(value)}; }\n`,
	);
}

describe("Track A profile HMR transactions", () => {
	test("a shared source edit reloads all importers once and leaves a declined plugin running", async () => {
		await writeShared("shared-v1");
		const a = await writePlugin("profile-a", "profile-a", true);
		const b = await writePlugin("profile-b", "profile-b", true);
		const c = await writePlugin("profile-c", "profile-c");
		const paths = [a, b, c];
		const [ha, hb, hc] = [await runtime.load(a, root), await runtime.load(b, root), await runtime.load(c, root)];
		expect(await hc.invoke("profile-c-count")).toBe("1");

		await writeShared("shared-v2");
		const reloaded = await runtime.loadAll(paths, root);

		expect(reloaded.errors).toEqual([]);
		expect(await ha.invoke("profile-a")).toBe("shared-v2");
		expect(await hb.invoke("profile-b")).toBe("shared-v2");
		expect(await hc.invoke("profile-c")).toBe("profile-c-v1");
		expect(await hc.invoke("profile-c-count")).toBe("2");
		expect(await ha.invoke("profile-a-count")).toBe("1");

		await runtime.loadAll(paths, root);
		expect(await ha.invoke("profile-a-count")).toBe("2");
	});

	test("an import failure leaves every old instance active", async () => {
		await writeShared("shared-v1");
		const a = await writePlugin("import-a", "import-a", true);
		const b = await writePlugin("import-b", "import-b", true);
		const ha = await runtime.load(a, root);
		const hb = await runtime.load(b, root);

		await fs.writeFile(path.join(root, "shared.ts"), "export function sharedValue( {\n");
		const result = await runtime.loadAll([a, b], root);

		expect(result.errors.length).toBeGreaterThan(0);
		expect(await ha.invoke("import-a")).toBe("shared-v1");
		expect(await hb.invoke("import-b")).toBe("shared-v1");
		expect(
			runtime
				.inspect()
				.filter(record => record.name.startsWith("import-"))
				.every(record => record.status === "active"),
		).toBe(true);
	});

	test("an apply failure rolls back an already replaced sibling", async () => {
		await writeShared("shared-v1");
		const a = await writePlugin("apply-a", "apply-a", true);
		const b = await writePlugin("apply-b", "apply-b", true);
		const ha = await runtime.load(a, root);
		const hb = await runtime.load(b, root);

		await writeShared("shared-v2");
		await fs.writeFile(
			path.join(b, "index.ts"),
			'import { sharedValue } from "../shared";\nexport default function (_pi: any) {\n	void sharedValue;\n	throw new Error("replacement apply failed");\n}\n',
		);
		const result = await runtime.loadAll([a, b], root);

		expect(result.errors.some(error => error.error.includes("replacement apply failed"))).toBe(true);
		expect(await ha.invoke("apply-a")).toBe("shared-v1");
		expect(await hb.invoke("apply-b")).toBe("shared-v1");
	});
});
