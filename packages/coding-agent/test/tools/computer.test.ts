import { describe, expect, it } from "bun:test";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { Api, ComputerAction, ComputerToolCallMetadata, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import {
	type ComputerParams,
	ComputerTool,
	computerApproval,
	createTools,
	type ToolSession,
} from "@oh-my-pi/pi-coding-agent/tools";
import type {
	ComputerWorkerInbound,
	ComputerWorkerOutbound,
	ComputerWorkerTransport,
} from "@oh-my-pi/pi-coding-agent/tools/computer/protocol";
import {
	type ComputerController,
	ComputerSupervisor,
	type ComputerWorkerHandle,
	registerComputerController,
	releaseComputerSessionsForOwner,
	smokeTestComputerWorker,
} from "@oh-my-pi/pi-coding-agent/tools/computer/supervisor";
import { ComputerWorkerCore, type NativeDesktopSession } from "@oh-my-pi/pi-coding-agent/tools/computer/worker";
import { computerToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/computer-renderer";
import { buildNamedToolChoice, isToolChoiceActive } from "@oh-my-pi/pi-coding-agent/utils/tool-choice";
import type { DesktopAction, DesktopCapabilities, DesktopCapture, DesktopSessionOptions } from "@oh-my-pi/pi-natives";
import { type as arkType } from "arktype";

const capabilities: DesktopCapabilities = {
	capture: true,
	input: true,
	backend: "test-native",
	displayServer: "test",
	capturePermission: "granted",
	inputPermission: "granted",
	displayCount: 1,
};
function capture(byte: number): DesktopCapture {
	return {
		data: Uint8Array.of(byte),
		width: 1280,
		height: 720,
		backend: "test-native",
		displayServer: "test",
		capturePermission: "granted",
		inputPermission: "granted",
		displays: [
			{
				id: "display-1",
				name: "Primary",
				x: 0,
				y: 0,
				width: 1280,
				height: 720,
				pixelX: 0,
				pixelY: 0,
				pixelWidth: 2560,
				pixelHeight: 1440,
				scale: 2,
				isPrimary: true,
			},
		],
	} as DesktopCapture;
}

class TestTransport implements ComputerWorkerTransport {
	readonly outbound: ComputerWorkerOutbound[] = [];
	#handler?: (message: ComputerWorkerInbound) => void;

	send(message: ComputerWorkerOutbound): void {
		this.outbound.push(message);
	}

	onMessage(handler: (message: ComputerWorkerInbound) => void): () => void {
		this.#handler = handler;
		return () => {
			if (this.#handler === handler) this.#handler = undefined;
		};
	}

	close(): void {}

	inbound(message: ComputerWorkerInbound): void {
		this.#handler?.(message);
	}
}

async function settle(): Promise<void> {
	await Bun.sleep(100);
}

class FakeNativeSession implements NativeDesktopSession {
	capabilityDisplayCount = 0;
	readonly calls: Array<{ type: "capture" } | { type: "execute"; actions: DesktopAction[] }> = [];
	active = 0;
	maxActive = 0;
	closeCount = 0;
	#captureId = 0;
	get capabilities(): DesktopCapabilities {
		return { ...capabilities, displayCount: this.capabilityDisplayCount };
	}

	async capture(): Promise<DesktopCapture> {
		this.calls.push({ type: "capture" });
		this.capabilityDisplayCount = 1;
		return capture(++this.#captureId);
	}

	async execute(actions: DesktopAction[]): Promise<DesktopCapture> {
		this.calls.push({ type: "execute", actions });
		this.capabilityDisplayCount = 2;
		this.active += 1;
		this.maxActive = Math.max(this.maxActive, this.active);
		await Bun.sleep(5);
		this.active -= 1;
		return capture(++this.#captureId);
	}

	async close(): Promise<void> {
		this.closeCount += 1;
	}
}

class FakeController implements ComputerController {
	readonly capabilities = capabilities;
	readonly batches: DesktopAction[][] = [];
	closeCount = 0;

	async execute(actions: DesktopAction[]): Promise<DesktopCapture> {
		this.batches.push(actions);
		return capture(this.batches.length);
	}

	async close(): Promise<void> {
		this.closeCount += 1;
	}
}

class NonClosingWorker implements ComputerWorkerHandle {
	#messageHandlers = new Set<(message: ComputerWorkerOutbound) => void>();
	terminateCount = 0;

	send(message: ComputerWorkerInbound): void {
		if (message.type === "init") {
			queueMicrotask(() => this.#emit({ type: "ready", capabilities: { ...capabilities, displayCount: 0 } }));
		} else if (message.type === "execute") {
			queueMicrotask(() =>
				this.#emit({
					type: "result",
					id: message.id,
					capture: capture(9),
					capabilities: { ...capabilities, displayCount: 2 },
				}),
			);
		}
		// Deliberately ignore close: supervisor must hit its deadline and terminate.
	}

	onMessage(handler: (message: ComputerWorkerOutbound) => void): () => void {
		this.#messageHandlers.add(handler);
		return () => this.#messageHandlers.delete(handler);
	}

	onError(_handler: (error: Error) => void): () => void {
		return () => {};
	}

	async terminate(): Promise<void> {
		this.terminateCount += 1;
	}

	#emit(message: ComputerWorkerOutbound): void {
		for (const handler of this.#messageHandlers) handler(message);
	}
}

class SmokeWorker implements ComputerWorkerHandle {
	readonly sent: ComputerWorkerInbound[] = [];
	#messageHandlers = new Set<(message: ComputerWorkerOutbound) => void>();
	terminateCount = 0;

	send(message: ComputerWorkerInbound): void {
		this.sent.push(message);
		if (message.type === "init") {
			queueMicrotask(() => this.#emit({ type: "ready", capabilities }));
		} else if (message.type === "close") {
			queueMicrotask(() => this.#emit({ type: "closed" }));
		}
	}

	onMessage(handler: (message: ComputerWorkerOutbound) => void): () => void {
		this.#messageHandlers.add(handler);
		return () => this.#messageHandlers.delete(handler);
	}

	onError(_handler: (error: Error) => void): () => void {
		return () => {};
	}

	async terminate(): Promise<void> {
		this.terminateCount += 1;
	}

	#emit(message: ComputerWorkerOutbound): void {
		for (const handler of this.#messageHandlers) handler(message);
	}
}

function toolSession(settings: Settings, model?: Model<Api>): ToolSession {
	return {
		cwd: ".",
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getActiveModel: () => model,
	} as ToolSession;
}

function callContext(
	settings: Settings,
	actions: ComputerAction[],
	pendingSafetyChecks: ComputerToolCallMetadata["pendingSafetyChecks"] = [],
): AgentToolContext {
	return {
		settings,
		toolCall: {
			batchId: "batch",
			index: 0,
			total: 1,
			toolCalls: [{ id: "call", name: "computer" }],
			providerMetadata: {
				type: "computer",
				providerItemId: "provider-call",
				actions,
				pendingSafetyChecks,
			},
		},
	} as AgentToolContext;
}

describe("native computer worker", () => {
	const unseenFrameMessage =
		"Coordinate computer actions require a screenshot returned to the provider; request a screenshot first";

	it("rejects every first-call coordinate action without capturing or executing native input", async () => {
		const transport = new TestTransport();
		const native = new FakeNativeSession();
		const options: DesktopSessionOptions = { backend: "native", display: "all", maxWidth: 1920, maxHeight: 1200 };
		new ComputerWorkerCore(transport, () => native);
		const coordinateActions: DesktopAction[] = [
			{ type: "click", x: 10, y: 20, button: "left" },
			{ type: "double_click", x: 10, y: 20 },
			{
				type: "drag",
				path: [
					{ x: 10, y: 20 },
					{ x: 30, y: 40 },
				],
			},
			{ type: "move", x: 10, y: 20 },
			{ type: "scroll", x: 10, y: 20, scroll_x: 0, scroll_y: 100 },
		];

		transport.inbound({ type: "init", options });
		for (const [index, action] of coordinateActions.entries()) {
			transport.inbound({ type: "execute", id: `coordinate-${String(index)}`, actions: [action] });
		}
		await settle();

		expect(native.calls).toEqual([]);
		expect(transport.outbound.filter(message => message.type === "error")).toEqual(
			coordinateActions.map((_, index) => ({
				type: "error",
				id: `coordinate-${String(index)}`,
				error: { name: "Error", message: unseenFrameMessage },
			})),
		);
	});

	it("uses a returned screenshot for later coordinates while preserving ordered fresh results", async () => {
		const transport = new TestTransport();
		const native = new FakeNativeSession();
		const options: DesktopSessionOptions = { backend: "native", display: "all", maxWidth: 1920, maxHeight: 1200 };
		new ComputerWorkerCore(transport, received => {
			expect(received).toEqual(options);
			return native;
		});

		transport.inbound({ type: "init", options });
		transport.inbound({ type: "execute", id: "screenshot", actions: [{ type: "screenshot" }] });
		transport.inbound({
			type: "execute",
			id: "coordinate",
			actions: [{ type: "click", x: 10, y: 20, button: "left" }],
		});
		transport.inbound({ type: "execute", id: "keyboard", actions: [{ type: "keypress", keys: ["CTRL", "L"] }] });
		await settle();

		expect(native.calls).toEqual([
			{ type: "execute", actions: [{ type: "screenshot" }] },
			{ type: "execute", actions: [{ type: "click", x: 10, y: 20, button: "left" }] },
			{ type: "execute", actions: [{ type: "keypress", keys: ["CTRL", "L"] }] },
		]);
		expect(native.maxActive).toBe(1);
		const results = transport.outbound.filter(message => message.type === "result");
		expect(results.map(result => [result.id, result.capture.data[0]])).toEqual([
			["screenshot", 1],
			["coordinate", 2],
			["keyboard", 3],
		]);
		expect(results.map(result => result.capabilities.displayCount)).toEqual([2, 2, 2]);

		transport.inbound({ type: "close" });
		transport.inbound({ type: "close" });
		await settle();
		expect(native.closeCount).toBe(1);
	});

	it("uses a returned non-coordinate result for later coordinates", async () => {
		const transport = new TestTransport();
		const native = new FakeNativeSession();
		const options: DesktopSessionOptions = { backend: "native", display: "all", maxWidth: 1920, maxHeight: 1200 };
		new ComputerWorkerCore(transport, () => native);

		transport.inbound({ type: "init", options });
		transport.inbound({ type: "execute", id: "keyboard", actions: [{ type: "keypress", keys: ["TAB"] }] });
		transport.inbound({ type: "execute", id: "coordinate", actions: [{ type: "move", x: 30, y: 40 }] });
		await settle();

		expect(native.calls).toEqual([
			{ type: "execute", actions: [{ type: "keypress", keys: ["TAB"] }] },
			{ type: "execute", actions: [{ type: "move", x: 30, y: 40 }] },
		]);
		expect(transport.outbound.filter(message => message.type === "result").map(result => result.id)).toEqual([
			"keyboard",
			"coordinate",
		]);
	});

	it("resets returned-frame state when the worker is recreated", async () => {
		const options: DesktopSessionOptions = { backend: "native", display: "all", maxWidth: 1920, maxHeight: 1200 };
		const firstTransport = new TestTransport();
		const firstNative = new FakeNativeSession();
		new ComputerWorkerCore(firstTransport, () => firstNative);
		firstTransport.inbound({ type: "init", options });
		firstTransport.inbound({ type: "execute", id: "screenshot", actions: [{ type: "screenshot" }] });
		await settle();
		expect(firstTransport.outbound.some(message => message.type === "result")).toBe(true);

		const recreatedTransport = new TestTransport();
		const recreatedNative = new FakeNativeSession();
		new ComputerWorkerCore(recreatedTransport, () => recreatedNative);
		recreatedTransport.inbound({ type: "init", options });
		recreatedTransport.inbound({
			type: "execute",
			id: "coordinate-first",
			actions: [{ type: "scroll", x: 10, y: 20, scroll_x: 0, scroll_y: 100 }],
		});
		await settle();

		expect(recreatedNative.calls).toEqual([]);
		expect(recreatedTransport.outbound).toContainEqual({
			type: "error",
			id: "coordinate-first",
			error: { name: "Error", message: unseenFrameMessage },
		});
	});
});

describe("computer supervisor", () => {
	it("constructs and closes a native session during install smoke", async () => {
		const worker = new SmokeWorker();
		await smokeTestComputerWorker(50, () => worker);
		expect(worker.sent).toEqual([
			{
				type: "init",
				options: { backend: "auto", display: "all", maxWidth: 1920, maxHeight: 1200 },
			},
			{ type: "close" },
		]);
		expect(worker.terminateCount).toBe(1);
	});

	it("force-terminates a worker that misses the bounded close handshake", async () => {
		const worker = new NonClosingWorker();
		const supervisor = new ComputerSupervisor(
			{ backend: "auto", display: "all", maxWidth: 1920, maxHeight: 1200 },
			() => worker,
			{ startMs: 50, closeMs: 10 },
		);
		await supervisor.execute([{ type: "screenshot" }]);
		expect(supervisor.capabilities?.displayCount).toBe(2);
		await supervisor.close();
		await supervisor.close();
		expect(worker.terminateCount).toBe(1);
	});

	it("releases a controller registered before an AgentSession owns cleanup", async () => {
		const controller = new FakeController();
		const unregister = registerComputerController("startup-failure-owner", controller);
		await releaseComputerSessionsForOwner("startup-failure-owner");
		unregister();
		expect(controller.closeCount).toBe(1);
	});
});

describe("computer tool choice", () => {
	it("uses native forced choice for GA models and named function choice for the fallback", () => {
		const supported = { api: "openai-responses", supportsComputerUse: true } as unknown as Model<Api>;
		expect(buildNamedToolChoice("computer", supported)).toEqual({ type: "computer" });
		for (const api of ["openai-responses", "openai-codex-responses", "azure-openai-responses"] as const) {
			const unsupported = { api, supportsComputerUse: false } as unknown as Model<Api>;
			expect(buildNamedToolChoice("computer", unsupported)).toEqual({ type: "function", name: "computer" });
		}
		expect(isToolChoiceActive({ type: "computer" }, [{ name: "computer" }])).toBe(true);
		expect(isToolChoiceActive({ type: "computer" }, [{ name: "read" }])).toBe(false);
	});
});

describe("computer tool", () => {
	it("is disabled by default and essential when enabled", async () => {
		const disabled = await createTools(toolSession(Settings.isolated()), ["computer"]);
		expect(disabled).toHaveLength(0);
		const enabled = await createTools(toolSession(Settings.isolated({ "computer.enabled": true })), ["computer"]);
		expect(enabled.map(tool => [tool.name, tool.loadMode])).toEqual([["computer", "essential"]]);
		expect(enabled[0]?.strict).toBe(false);
	});

	it("accepts each GA action shape through the params schema and rejects malformed shapes", () => {
		const tool = new ComputerTool(
			toolSession(Settings.isolated({ "computer.enabled": true })),
			() => new FakeController(),
		);
		const ok = tool.parameters({
			actions: [
				{ type: "click", x: 1, y: 2, button: "left", keys: null },
				{ type: "double_click", x: 3, y: 4 },
				{
					type: "drag",
					path: [
						{ x: 0, y: 0 },
						{ x: 9, y: 9 },
					],
				},
				{ type: "keypress", keys: ["CTRL", "A"] },
				{ type: "move", x: 5, y: 6 },
				{ type: "screenshot" },
				{ type: "scroll", x: 7, y: 8, scroll_x: -10, scroll_y: 20 },
				{ type: "type", text: "hello" },
				{ type: "wait" },
			],
		});
		expect(ok instanceof arkType.errors).toBe(false);
		for (const actions of [
			[{ type: "click", x: -1, y: 2, button: "left" }],
			[{ type: "move", x: 0.5, y: 0 }],
			[{ type: "scroll", x: 0, y: 0, scroll_x: 2 ** 31, scroll_y: 0 }],
			[{ type: "drag", path: [{ x: 0, y: 0 }] }],
			[
				{
					type: "drag",
					path: [
						{ x: 0, y: 0, label: "unexpected" },
						{ x: 1, y: 1 },
					],
				},
			],
		]) {
			expect(tool.parameters({ actions }) instanceof arkType.errors).toBe(true);
		}
		expect(tool.parameters({ actions: [], unexpected: true }) instanceof arkType.errors).toBe(true);
	});

	it("executes function-call params.actions and defaults omitted, undefined, null, and empty batches to a screenshot", async () => {
		const controller = new FakeController();
		const tool = new ComputerTool(toolSession(Settings.isolated({ "computer.enabled": true })), () => controller);
		const result = await tool.execute("call", { actions: [{ type: "click", x: 5, y: 6, button: "left" }] });
		expect(result.content).toEqual([{ type: "image", data: "AQ==", mimeType: "image/png", detail: "original" }]);
		expect(result.providerMetadata).toBeUndefined();
		await tool.execute("call", {});
		await tool.execute("call", { actions: undefined } as unknown as ComputerParams);
		await tool.execute("call", { actions: null } as unknown as ComputerParams);
		await tool.execute("call", { actions: [] });
		expect(controller.batches).toEqual([
			[{ type: "click", x: 5, y: 6, button: "left" }],
			[{ type: "screenshot" }],
			[{ type: "screenshot" }],
			[{ type: "screenshot" }],
			[{ type: "screenshot" }],
		]);
		await tool.close();
	});

	it("fails closed on malformed action fields before native dispatch", async () => {
		const controller = new FakeController();
		const tool = new ComputerTool(toolSession(Settings.isolated({ "computer.enabled": true })), () => controller);
		const invalidBatches = [
			[{ type: "click", x: 1.5, y: 2, button: "left" }],
			[{ type: "move", x: -1, y: 2 }],
			[{ type: "move", x: 2 ** 31, y: 0 }],
			[{ type: "scroll", x: 0, y: 0, scroll_x: 0, scroll_y: -(2 ** 31) - 1 }],
			[{ type: "drag", path: [{ x: 0, y: 0 }] }],
			[
				{
					type: "drag",
					path: [
						{ x: 0, y: 0 },
						{ x: 3, y: 4, extra: true },
					],
				},
			],
			[{ type: "click", x: 1, y: 2, button: "left", keys: ["ENTER"] }],
			[{ type: "click", x: 1, y: 2, button: "left", keys: ["CTRL", "CONTROL"] }],
			[{ type: "keypress", keys: [] }],
			[{ type: "keypress", keys: ["CTRL+"] }],
			[{ type: "screenshot", x: 1 }],
			[{ type: "type", text: "hello", y: 2 }],
		] as unknown as ComputerParams["actions"][];
		for (const actions of invalidBatches) {
			await expect(tool.execute("call", { actions })).rejects.toThrow("Computer call contains an invalid action");
		}
		expect(controller.batches).toHaveLength(0);
		await tool.execute("call", {
			actions: [{ type: "scroll", x: 0, y: 0, scroll_x: -2_147_483_648, scroll_y: 2_147_483_647 }],
		});
		expect(controller.batches).toEqual([
			[{ type: "scroll", x: 0, y: 0, scroll_x: -2_147_483_648, scroll_y: 2_147_483_647 }],
		]);
		await tool.close();
	});

	it("preserves smaller configured capture limits for Claude-family transports", async () => {
		const settings = Settings.isolated({
			"computer.enabled": true,
			"computer.maxWidth": 960,
			"computer.maxHeight": 640,
		});
		const model = { id: "claude-sonnet-4-6", api: "openai-completions" } as unknown as Model<Api>;
		let receivedOptions: DesktopSessionOptions | undefined;
		const tool = new ComputerTool(toolSession(settings, model), options => {
			receivedOptions = options;
			return new FakeController();
		});

		expect(receivedOptions).toMatchObject({ maxWidth: 960, maxHeight: 640 });
		await tool.close();
	});

	it("caps Claude-family captures without changing the public defaults", async () => {
		const settings = Settings.isolated({ "computer.enabled": true });
		const model = { id: "claude-opus-4-8", api: "openai-completions" } as unknown as Model<Api>;
		let receivedOptions: DesktopSessionOptions | undefined;
		const tool = new ComputerTool(toolSession(settings, model), options => {
			receivedOptions = options;
			return new FakeController();
		});

		expect(settings.get("computer.maxWidth")).toBe(1920);
		expect(settings.get("computer.maxHeight")).toBe(1200);
		expect(receivedOptions).toMatchObject({ maxWidth: 1280, maxHeight: 896 });
		await tool.close();
	});

	it("caps Copilot GPT-5 Responses captures when original image detail is unavailable", async () => {
		const settings = Settings.isolated({ "computer.enabled": true });
		const model = buildModel({
			id: "gpt-5.5",
			name: "GPT-5.5",
			api: "openai-responses",
			provider: "github-copilot",
			baseUrl: "https://api.githubcopilot.com",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 32_000,
		});
		let receivedOptions: DesktopSessionOptions | undefined;
		const tool = new ComputerTool(toolSession(settings, model), options => {
			receivedOptions = options;
			return new FakeController();
		});

		expect(settings.get("computer.maxWidth")).toBe(1920);
		expect(settings.get("computer.maxHeight")).toBe(1200);
		expect(receivedOptions).toMatchObject({ maxWidth: 1280, maxHeight: 896 });
		await tool.close();
	});

	it("recognizes Claude aliases without classifying every Anthropic-API model as Claude", async () => {
		const settings = Settings.isolated({ "computer.enabled": true });
		const claudeModels = [
			{ id: "anthropic/claude-sonnet-4-6" },
			{ id: "us.anthropic.claude-haiku-4-5-20251001-v1:0" },
			{ id: "local-alias", requestModelId: "claude-opus-4-8" },
			{ id: "claude-opus-4-8", requestModelId: "upstream-alias" },
			{ id: "opaque-proxy-alias", name: "Claude Sonnet 4.6" },
		] as unknown as Model<Api>[];
		for (const model of claudeModels) {
			let receivedOptions: DesktopSessionOptions | undefined;
			const tool = new ComputerTool(toolSession(settings, model), options => {
				receivedOptions = options;
				return new FakeController();
			});
			expect(receivedOptions).toMatchObject({ maxWidth: 1280, maxHeight: 896 });
			await tool.close();
		}

		for (const model of [{ id: "MiniMax-M2.5", api: "anthropic-messages" }, undefined] as Array<
			Model<Api> | undefined
		>) {
			let receivedOptions: DesktopSessionOptions | undefined;
			const tool = new ComputerTool(toolSession(settings, model), options => {
				receivedOptions = options;
				return new FakeController();
			});
			expect(receivedOptions).toMatchObject({ maxWidth: 1920, maxHeight: 1200 });
			await tool.close();
		}
	});

	it("recreates the controller when model switches cross the Claude sizing boundary", async () => {
		const settings = Settings.isolated({ "computer.enabled": true });
		const gpt = { id: "gpt-5.6", api: "openai-responses" } as unknown as Model<Api>;
		const claude = { id: "claude-sonnet-4-6", api: "openai-completions" } as unknown as Model<Api>;
		let activeModel = gpt;
		const session = toolSession(settings);
		session.getActiveModel = () => activeModel;
		const receivedOptions: DesktopSessionOptions[] = [];
		const controllers: FakeController[] = [];
		const tool = new ComputerTool(session, options => {
			receivedOptions.push(options);
			const controller = new FakeController();
			controllers.push(controller);
			return controller;
		});

		activeModel = claude;
		await tool.execute("call", { actions: [{ type: "screenshot" }] });
		activeModel = gpt;
		await tool.execute("call", { actions: [{ type: "screenshot" }] });

		expect(receivedOptions.map(options => [options.maxWidth, options.maxHeight])).toEqual([
			[1920, 1200],
			[1280, 896],
			[1920, 1200],
		]);
		expect(controllers.map(controller => controller.closeCount)).toEqual([1, 1, 0]);
		expect(controllers.map(controller => controller.batches.length)).toEqual([0, 1, 1]);
		await tool.close();
	});

	it("uses registered native options, adapts every GA field, and returns exactly one fresh PNG with metadata", async () => {
		const settings = Settings.isolated({
			"computer.enabled": true,
			"computer.backend": "native",
			"computer.display": "display-1",
			"computer.maxWidth": 1600,
			"computer.maxHeight": 1000,
		});
		const model = {
			id: "gpt-5.6",
			api: "openai-responses",
			supportsComputerUse: true,
		} as unknown as Model<Api>;
		const controller = new FakeController();
		let receivedOptions: DesktopSessionOptions | undefined;
		const tool = new ComputerTool(toolSession(settings, model), options => {
			receivedOptions = options;
			return controller;
		});
		expect(tool.effectiveConfiguration).toEqual({
			backend: "native",
			display: "display-1",
			maxWidth: 1600,
			maxHeight: 1000,
		});
		expect(Object.isFrozen(tool.effectiveConfiguration)).toBe(true);
		settings.override("computer.display", "all");
		settings.override("computer.maxWidth", 1920);
		expect(tool.effectiveConfiguration).toMatchObject({ display: "display-1", maxWidth: 1600 });
		const actions: ComputerAction[] = [
			{ type: "click", x: 11, y: 22, button: "right", keys: ["SHIFT"] },
			{ type: "double_click", x: 30, y: 40, keys: null },
			{
				type: "drag",
				path: [
					{ x: 1, y: 2 },
					{ x: 3, y: 4 },
				],
				keys: ["ALT"],
			},
			{ type: "keypress", keys: ["CTRL", "A"] },
			{ type: "move", x: 50, y: 60, keys: null },
			{ type: "screenshot" },
			{ type: "scroll", x: 70, y: 80, scroll_x: -10, scroll_y: 20, keys: ["SHIFT"] },
			{ type: "type", text: "hello" },
			{ type: "wait" },
		];
		const context = callContext(settings, actions);
		const result = await tool.execute("call", {}, undefined, undefined, context);

		expect(receivedOptions).toEqual({
			backend: "native",
			display: "display-1",
			maxWidth: 1600,
			maxHeight: 1000,
		});
		expect(controller.batches).toEqual([
			[
				{ type: "click", x: 11, y: 22, button: "right", keys: ["SHIFT"] },
				{ type: "double_click", x: 30, y: 40 },
				{
					type: "drag",
					path: [
						{ x: 1, y: 2 },
						{ x: 3, y: 4 },
					],
					keys: ["ALT"],
				},
				{ type: "keypress", keys: ["CTRL", "A"] },
				{ type: "move", x: 50, y: 60 },
				{ type: "screenshot" },
				{ type: "scroll", x: 70, y: 80, scroll_x: -10, scroll_y: 20, keys: ["SHIFT"] },
				{ type: "type", text: "hello" },
				{ type: "wait" },
			],
		]);
		expect(result.content).toEqual([{ type: "image", data: "AQ==", mimeType: "image/png", detail: "original" }]);
		expect(result.details).toMatchObject({
			width: 1280,
			height: 720,
			backend: "test-native",
			capabilities,
		});
		expect(result.providerMetadata).toEqual({
			type: "computer",
			screenshot: { type: "computer_screenshot", image_url: "data:image/png;base64,AQ==" },
			acknowledgedSafetyChecks: [],
		});
		await tool.close();
		await tool.close();
		expect(controller.closeCount).toBe(1);
	});

	it("classifies screenshot-default and observation-only calls as read while malformed and input calls require exec", () => {
		for (const args of [
			{},
			{ actions: undefined },
			{ actions: null },
			{ actions: [] },
			{ actions: [{ type: "screenshot" }, { type: "wait" }] },
		]) {
			expect(computerApproval(args)).toBe("read");
		}
		for (const actions of ["screenshot", { type: "screenshot" }, [{ type: "move", x: 1, y: 2 }]]) {
			expect(computerApproval({ actions })).toBe("exec");
		}
	});

	it("shows exact action details at approval time", () => {
		const tool = new ComputerTool(
			toolSession(Settings.isolated({ "computer.enabled": true })),
			() => new FakeController(),
		);
		const details = tool.formatApprovalDetails({
			actions: [
				{ type: "click", x: 1, y: 2, button: "right", keys: ["SHIFT"] },
				{ type: "keypress", keys: ["ENTER"] },
				{ type: "scroll", x: 3, y: 4, scroll_x: -5, scroll_y: 6, keys: ["ALT"] },
				{
					type: "drag",
					path: [
						{ x: 7, y: 8 },
						{ x: 9, y: 10 },
					],
					keys: ["CTRL"],
				},
			],
		});
		expect(details).toEqual([
			'1. click button=right at (1, 2) keys=["SHIFT"]',
			'2. keypress keys=["ENTER"]',
			'3. scroll at (3, 4) delta=(-5, 6) keys=["ALT"]',
			'4. drag path=(7, 8) -> (9, 10) keys=["CTRL"]',
		]);
	});

	it("bounds provider-supplied approval details", () => {
		const tool = new ComputerTool(
			toolSession(Settings.isolated({ "computer.enabled": true })),
			() => new FakeController(),
		);
		const details = tool.formatApprovalDetails({
			actions: Array.from({ length: 20 }, () => ({ type: "type", text: "x".repeat(1_000) })),
		});
		const summary = details.join("\n");
		expect(summary.length).toBeLessThan(2_100);
		expect(summary).toContain("elided");
	});
});

describe("provider computer safety", () => {
	it("fails closed in headless yolo mode despite a per-tool allow", async () => {
		const settings = Settings.isolated({
			"computer.enabled": true,
			"tools.approvalMode": "yolo",
			"tools.approval": { computer: "allow" },
		});
		const controller = new FakeController();
		const tool = new ComputerTool(toolSession(settings), () => controller);
		const runner = {
			hasHandlers: () => false,
			hasUI: () => false,
			consumeToolCallEmitted: () => false,
		} as unknown as ExtensionRunner;
		const wrapped = new ExtensionToolWrapper(tool as unknown as AgentTool, runner);
		const context = callContext(
			settings,
			[{ type: "click", x: 1, y: 2, button: "left" }],
			[{ id: "risk-1", code: "external_side_effect", message: "This action submits the form" }],
		);
		await expect(wrapped.execute("call", {}, undefined, undefined, context)).rejects.toThrow(
			/pending provider safety checks but no interactive UI/,
		);
		expect(controller.batches).toHaveLength(0);
	});

	it("asks with provider safety details and acknowledges only after approval", async () => {
		const settings = Settings.isolated({ "computer.enabled": true, "tools.approvalMode": "yolo" });
		const controller = new FakeController();
		const tool = new ComputerTool(toolSession(settings), () => controller);
		let promptText = "";
		const runner = {
			hasHandlers: () => false,
			hasUI: () => true,
			consumeToolCallEmitted: () => false,
			getUIContext: () => ({
				select: async (message: string) => {
					promptText = message;
					return "Approve";
				},
			}),
		} as unknown as ExtensionRunner;
		const wrapped = new ExtensionToolWrapper(tool as unknown as AgentTool, runner);
		const checks = [{ id: "risk-1", message: "Submit external form" }];
		const result = await wrapped.execute(
			"call",
			{},
			undefined,
			undefined,
			callContext(settings, [{ type: "click", x: 1, y: 2, button: "left" }], checks),
		);
		expect(promptText).toContain("Provider safety checks:\n1. Submit external form");
		expect(promptText).toContain("click button=left at (1, 2)");
		expect(result.providerMetadata).toMatchObject({ acknowledgedSafetyChecks: checks });
		expect(controller.batches).toHaveLength(1);
	});
});

it("passes provider-native actions and safety checks to extension policy hooks", async () => {
	const settings = Settings.isolated({ "computer.enabled": true, "tools.approvalMode": "yolo" });
	const controller = new FakeController();
	const tool = new ComputerTool(toolSession(settings), () => controller);
	const actions: ComputerAction[] = [{ type: "click", x: 21, y: 34, button: "right", keys: ["SHIFT"] }];
	const checks = [{ id: "risk-hook", code: "external_side_effect", message: "Submit form" }];
	let hookInput: Record<string, unknown> | undefined;
	const runner = {
		hasHandlers: (type: string) => type === "tool_call",
		hasUI: () => true,
		consumeToolCallEmitted: () => false,
		getUIContext: () => ({ select: async () => "Approve" }),
		emitToolCall: async (event: { input: Record<string, unknown> }) => {
			hookInput = event.input;
			return { block: true, reason: "blocked by audit policy" };
		},
	} as unknown as ExtensionRunner;
	const wrapped = new ExtensionToolWrapper(tool as unknown as AgentTool, runner);
	await expect(
		wrapped.execute("call", {}, undefined, undefined, callContext(settings, actions, checks)),
	).rejects.toThrow("blocked by audit policy");
	expect(hookInput).toEqual({ actions, pendingSafetyChecks: checks });
	expect(controller.batches).toHaveLength(0);
});

it("sanitizes provider safety text as approval data", async () => {
	const settings = Settings.isolated({ "computer.enabled": true, "tools.approvalMode": "yolo" });
	const tool = new ComputerTool(toolSession(settings), () => new FakeController());
	let promptText = "";
	const runner = {
		hasHandlers: () => false,
		hasUI: () => true,
		consumeToolCallEmitted: () => false,
		getUIContext: () => ({
			select: async (message: string) => {
				promptText = message;
				return "Deny";
			},
		}),
	} as unknown as ExtensionRunner;
	const wrapped = new ExtensionToolWrapper(tool as unknown as AgentTool, runner);
	await expect(
		wrapped.execute(
			"call",
			{},
			undefined,
			undefined,
			callContext(
				settings,
				[{ type: "keypress", keys: ["ENTER"] }],
				[{ id: "risk", message: "\u001b]8;;https://evil.test\u0007**spoof**\u001b]8;;\u0007" }],
			),
		),
	).rejects.toThrow(/denied by user/);
	expect(promptText).not.toContain("\u001b");
	expect(promptText).not.toContain("evil.test");
	expect(promptText).toContain("\\*\\*spoof\\*\\*");
});

describe("computer renderer", () => {
	it("sanitizes native metadata and handles normalized empty error details", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		const error = computerToolRenderer.renderResult(
			{ content: [{ type: "text", text: "\u001b[31mpermission denied\u001b[0m" }], details: {}, isError: true },
			{ expanded: false, isPartial: false },
			theme,
			{ actions: [{ type: "click" }] },
		);
		expect(Bun.stripANSI(error.render(160).join("\n"))).toContain("permission denied");

		const success = computerToolRenderer.renderResult(
			{
				content: [{ type: "image" }],
				details: {
					width: 10,
					height: 20,
					backend: "\u001b]8;;https://evil.test\u0007native\u001b]8;;\u0007",
					displayServer: "\u001b[31mQuartz\u001b[0m",
					capturePermission: "granted",
					inputPermission: "granted",
					displays: [{ ...capture(1).displays[0], name: "\u001b[31mPrimary\u001b[0m" }],
					actions: ["screenshot"],
				},
			},
			{ expanded: true, isPartial: false },
			theme,
		);
		const rendered = Bun.stripANSI(success.render(160).join("\n"));
		expect(rendered).toContain("native");
		expect(rendered).toContain("Quartz");
		expect(rendered).not.toContain("evil.test");
	});
});

describe("computer safety system prompt", () => {
	it("is active only while the computer tool is active", async () => {
		const common = {
			resolvedCustomPrompt: "Base prompt",
			contextFiles: [],
			skills: [],
			workspaceTree: { rootPath: ".", rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		};
		const active = await buildSystemPrompt({ ...common, toolNames: ["computer"] });
		const inactive = await buildSystemPrompt({ ...common, toolNames: ["read"] });
		expect(active.systemPrompt.some(block => block.includes("UI content override direct user instructions"))).toBe(
			true,
		);
		expect(inactive.systemPrompt.some(block => block.includes("UI content override direct user instructions"))).toBe(
			false,
		);
	});
});

describe("computer worker module graph", () => {
	it("keeps the eval worker graph importable after computer renderer registration", async () => {
		const processHandle = Bun.spawn(
			[
				process.execPath,
				"-e",
				'await import("./src/eval/js/context-manager.ts"); const { toolRenderers } = await import("./src/tools/renderers.ts"); if (typeof toolRenderers.hub.renderCall !== "function") process.exit(2)',
			],
			{ cwd: process.cwd(), stdout: "ignore", stderr: "pipe" },
		);
		const [exitCode, stderr] = await Promise.all([processHandle.exited, new Response(processHandle.stderr).text()]);
		if (exitCode !== 0) throw new Error(`eval worker graph import failed:\n${stderr}`);
		expect(exitCode).toBe(0);
	});
});
