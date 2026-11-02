import { afterEach, describe, expect, test, vi } from "bun:test";
import { type } from "@musepi/musepi-type";
import { parseConfigFields } from "@musepi/pi-wire";
import type {
	ExtensionAPI,
	ExtensionComponent,
	ExtensionContext,
	ExtensionRpcHandler,
	ToolDefinition,
} from "../../extensibility/extensions/types";
import { AndroidDeviceService, type AndroidProcessRunner, type AndroidRunResult } from "./android-service";
import { apply } from "./index";
import { createAndroidEmulatorTool } from "./tools";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngResult(): AndroidRunResult {
	return { stdout: PNG, stderr: "", exitCode: 0 };
}

function runner(): AndroidProcessRunner {
	return {
		run: async (_command, args) =>
			args.includes("screencap") ? pngResult() : { stdout: new Uint8Array(), stderr: "", exitCode: 0 },
		start: () => ({ kill() {} }),
	};
}

describe("android_emulator tool", () => {
	test("returns a screenshot as model-visible image content", async () => {
		const service = new AndroidDeviceService({ runner: runner() });
		const tool = createAndroidEmulatorTool(type, service);
		const output = await tool.execute(
			"call",
			{ action: "screenshot", device: "emulator-5554" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(output.content).toEqual([
			{ type: "text", text: "Captured emulator-5554." },
			{ type: "image", data: Buffer.from(PNG).toString("base64"), mimeType: "image/png" },
		]);
		expect(output.details).toMatchObject({
			action: "screenshot",
			device: "emulator-5554",
			panelTab: {
				surface: "ext:panel.tab.android-emulator",
				target: "emulator-5554",
				dedupeKey: "emulator-5554",
			},
		});
	});

	test("returns a structured tool error instead of a false success", async () => {
		const service = new AndroidDeviceService({ runner: runner() });
		const tool = createAndroidEmulatorTool(type, service);
		const output = await tool.execute("call", { action: "start" }, undefined, undefined, {} as ExtensionContext);
		expect(output.isError).toBe(true);
		expect(output.content[0]).toMatchObject({ type: "text" });
	});
});

describe("Cordis plugin registration", () => {
	afterEach(() => vi.restoreAllMocks());

	test("declares valid executable path settings in the plugin manifest", async () => {
		const manifest = (await Bun.file(new URL("./package.json", import.meta.url)).json()) as {
			musepi: { config: unknown };
		};
		const parsed = parseConfigFields(manifest.musepi.config);
		expect(parsed.errors).toEqual([]);
		expect(parsed.fields.map(field => field.key)).toEqual(["adbPath", "emulatorPath"]);
	});

	test("owns its RPC, component, tool and service disposal", async () => {
		const rpcs = new Map<string, ExtensionRpcHandler>();
		const tools: ToolDefinition[] = [];
		const components: ExtensionComponent[] = [];
		const toolViews: Array<{ tool: string; moduleUrl: string; label?: string }> = [];
		const effects: Array<() => void> = [];
		let service: AndroidDeviceService | undefined;
		const pi = {
			arktype: type,
			setLabel() {},
			registerRpc(method: string, handler: ExtensionRpcHandler) {
				rpcs.set(method, handler);
			},
			registerTool(tool: ToolDefinition) {
				tools.push(tool);
			},
			registerComponent(component: ExtensionComponent) {
				components.push(component);
			},
			registerToolView(tool: string, options: { moduleUrl: string; label?: string }) {
				toolViews.push({ tool, ...options });
			},
			effect(effect: () => void) {
				effects.push(effect);
			},
			config: {
				async get() {
					return undefined;
				},
			},
			logger: { info() {} },
		} as unknown as ExtensionAPI;
		vi.spyOn(AndroidDeviceService.prototype, "frame").mockImplementation(async function (
			this: AndroidDeviceService,
			device: string,
		) {
			service = this;
			return { device, png: PNG, capturedAt: Date.now() };
		});
		apply(pi);
		expect(components).toContainEqual(
			expect.objectContaining({ slot: "panel.tab.android-emulator", availability: "on-demand" }),
		);
		expect(tools.map(tool => tool.name)).toContain("android_emulator");
		expect(toolViews).toContainEqual({
			tool: "android_emulator",
			moduleUrl: "./ui/tool-view.tsx",
			label: "Android 模拟器",
		});
		const handler = rpcs.get("frame");
		expect(handler).toBeDefined();
		const response = await handler!({ device: "emulator-5554" }, { cwd: process.cwd() });
		expect(response).toMatchObject({ device: "emulator-5554", mimeType: "image/png" });
		for (const effect of effects) await effect();
		expect(service?.subscribers).toBe(0);
	});
});
