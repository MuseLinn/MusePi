import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventBus } from "../../utils/event-bus";
import { ExtensionRuntime } from "../extensions/loader";
import { CordisPresetRuntime } from "./preset-runtime";

declare global {
	var __presetCleanup: number | undefined;
}

let cwd: string;
let cleanupCount: number;

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-preset-runtime-"));
	cleanupCount = 0;
});

afterEach(() => {
	fs.rmSync(cwd, { recursive: true, force: true });
});

function plugin(name: string, source: string): string {
	const file = path.join(cwd, `${name}.js`);
	fs.writeFileSync(file, source, "utf8");
	return file;
}

function runtime(entries: Record<string, string>): CordisPresetRuntime {
	return new CordisPresetRuntime({
		cwd,
		eventBus: new EventBus(),
		runtime: new ExtensionRuntime(),
		entryResolver: {
			resolveEntries: async () => new Map(Object.entries(entries).map(([name, entry]) => [name, [entry]])),
		},
		readConfig: async () => ({ fields: [], values: {} }),
	});
}

async function rpc(
	record: { extension: { rpcs: Map<string, (params: unknown, ctx: { cwd: string }) => unknown> } },
	name: string,
) {
	return await record.extension.rpcs.get(name)!({}, { cwd });
}

describe("CordisPresetRuntime", () => {
	it("shares providers in the default realm and isolates duplicate names in another realm", async () => {
		const provider = (value: string) =>
			plugin(
				`provider-${value}.js`,
				`
				export const provide = ["dual"];
				export function apply() { return { dual: ${JSON.stringify(value)} }; }
			`,
			);
		const consumer = plugin(
			"consumer.js",
			`
			export const inject = ["dual"];
			export function apply(pi) { pi.registerRpc("value", () => pi.service("dual")); }
		`,
		);
		const owner = runtime({ provider: provider("default"), isolated: provider("isolated"), consumer });
		const result = await owner.mount([
			{ name: "provider" },
			{ name: "consumer" },
			{
				name: "cordis:group",
				group: true,
				isolate: { dual: true },
				config: [{ name: "isolated" }, { name: "consumer", id: "isolated-consumer" }],
			},
		]);
		expect(result.errors).toEqual([]);
		expect(await rpc(result.records[1]!, "value")).toBe("default");
		expect(await rpc(result.records[3]!, "value")).toBe("isolated");
		await owner.dispose();
	});

	it("refuses an isolated consumer whose provider exists only in the parent realm", async () => {
		const provider = plugin(
			"provider.js",
			`export const provide = ["dual"]; export function apply() { return { dual: 1 }; }`,
		);
		const consumer = plugin("consumer.js", `export const inject = ["dual"]; export function apply() {}`);
		const owner = runtime({ provider, consumer });
		const result = await owner.mount([{ name: "provider" }, { name: "consumer", isolate: { dual: true } }]);
		expect(result.errors[0]?.error).toContain("dual");
		await owner.dispose();
	});

	it("applies group isolation, passes row config, and disposes real plugin effects", async () => {
		const entry = plugin(
			"configured.js",
			`
			export const Config = {};
			export function apply(pi, config) {
				pi.registerRpc("config", () => config);
				pi.effect(() => { globalThis.__presetCleanup = (globalThis.__presetCleanup ?? 0) + 1; });
			}
		`,
		);
		const owner = runtime({ configured: entry });
		const result = await owner.mount([
			{
				name: "cordis:group",
				group: true,
				isolate: { dual: true },
				config: [{ name: "configured", config: { answer: 42 } }],
			},
		]);
		expect(result.errors).toEqual([]);
		expect(await rpc(result.records[0]!, "config")).toEqual({ answer: 42 });
		await owner.dispose();
		expect(globalThis.__presetCleanup).toBe(1);
		delete globalThis.__presetCleanup;
	});

	it("keeps disabled rows unmounted and exposes their registration records as tools", async () => {
		const entry = plugin(
			"tool.js",
			`
			export function apply(pi) {
				pi.registerTool({ name: "preset_tool", description: "preset", parameters: {}, execute: async () => ({ content: [] }) });
			}
		`,
		);
		const owner = runtime({ tool: entry });
		const result = await owner.mount([{ name: "tool", enabled: false }]);
		expect(result.records).toHaveLength(0);
		const mounted = await owner.mount([{ name: "tool" }]);
		expect([...mounted.records[0]!.extension.tools.keys()]).toEqual(["preset_tool"]);
		await owner.dispose();
	});
});
