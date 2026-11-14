import { describe, expect, it } from "bun:test";
import { type as arkType } from "@musepi/musepi-type";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { ComputerTool, computerApproval, type ToolSession } from "@musepi/pi-coding-agent/tools";
import type {
	ComputerSessionSnapshot,
	ComputerWorkerInbound,
	ComputerWorkerOutbound,
	ComputerWorkerTransport,
} from "@musepi/pi-coding-agent/tools/computer/protocol";
import { ComputerSupervisor, type ComputerWorkerHandle } from "@musepi/pi-coding-agent/tools/computer/supervisor";
import { ComputerWorkerCore, type NativeDesktopSession } from "@musepi/pi-coding-agent/tools/computer/worker";
import type {
	AxNode,
	AxQuery,
	AxSnapshotOptions,
	DesktopCapabilities,
	DesktopDisplay,
	DesktopPoint,
	DesktopWindow,
	PointerOptions,
} from "@musepi/pi-natives";

const capabilities: DesktopCapabilities = {
	backend: "fake",
	displayServer: "memory",
	capture: true,
	input: true,
	ax: true,
	backgroundWindowInput: true,
	overlay: false,
	deliveryModes: ["background", "foreground"],
	capturePermission: "granted",
	inputPermission: "granted",
	axPermission: "granted",
	displayCount: 1,
};

const display: DesktopDisplay = {
	id: "display-1",
	name: "Primary",
	x: 0,
	y: 0,
	width: 64,
	height: 32,
	scale: 1,
	pixelX: 0,
	pixelY: 0,
	pixelWidth: 64,
	pixelHeight: 32,
	isPrimary: true,
};

const windowFixture: DesktopWindow = {
	id: "42",
	title: "Editor",
	app: "Code",
	pid: 123,
	x: 4,
	y: 5,
	width: 40,
	height: 20,
	focused: true,
};

const axNode: AxNode = {
	ref: "e1",
	role: "button",
	nativeRole: "button",
	title: "Save",
	enabled: true,
	focused: false,
	childCount: 0,
	x: 7,
	y: 8,
	width: 9,
	height: 10,
};

interface FakeMenuItem {
	title: string;
	path: string[];
	enabled: boolean;
	checked: boolean;
	has_submenu: boolean;
	shortcut?: string;
}

interface FakeApplication {
	id: string;
	name: string;
	path: string;
	running: boolean;
	pid?: number;
}

class FakeNativeSession implements NativeDesktopSession {
	readonly capabilities = capabilities;
	listApplications?: (query?: { query?: string; runningOnly?: boolean }) => Promise<FakeApplication[]>;
	openApplication?: (target: string, options?: { activate?: boolean }) => Promise<FakeApplication>;
	menuItems?: (window: string, path: string[]) => Promise<FakeMenuItem[]>;
	menuSelect?: (window: string, path: string[]) => Promise<void>;
	clickCount = 0;
	closeCount = 0;
	sourceWidth = 64;
	sourceHeight = 32;

	async listDisplays(): Promise<DesktopDisplay[]> {
		return [display];
	}
	async listWindows(): Promise<DesktopWindow[]> {
		return [windowFixture];
	}
	async capture(target: string): Promise<{
		data: Uint8Array;
		width: number;
		height: number;
		sourceWidth: number;
		sourceHeight: number;
		target: string;
	}> {
		return {
			data: Uint8Array.of(137, 80, 78, 71),
			width: 64,
			height: 32,
			sourceWidth: this.sourceWidth,
			sourceHeight: this.sourceHeight,
			target,
		};
	}
	async click(_target: string, _x: number, _y: number, _opts?: PointerOptions | null): Promise<void> {
		this.clickCount += 1;
	}
	async moveMouse(_target: string, _x: number, _y: number, _opts?: PointerOptions | null): Promise<void> {}
	async drag(_target: string, _points: DesktopPoint[], _opts?: PointerOptions | null): Promise<void> {}
	async scroll(
		_target: string,
		_x: number,
		_y: number,
		_dx: number,
		_dy: number,
		_opts?: PointerOptions | null,
	): Promise<void> {}
	async typeText(_target: string, _text: string, _opts?: PointerOptions | null): Promise<void> {}
	async keyChord(_target: string, _keys: string[], _opts?: PointerOptions | null): Promise<void> {}
	async raiseWindow(_windowId: string): Promise<void> {}
	async axSnapshot(_target: string, _opts?: AxSnapshotOptions | null): Promise<{ text: string }> {
		return { text: "- button [ref=e1]" };
	}
	async axQuery(_target: string, _query: AxQuery): Promise<AxNode[]> {
		return [axNode];
	}
	async axElementAt(_target: string, _x: number, _y: number): Promise<AxNode | null> {
		return axNode;
	}
	async axFocused(): Promise<AxNode | null> {
		return axNode;
	}
	async axNode(_ref: string): Promise<AxNode> {
		return axNode;
	}
	async axAttributes(_ref: string): Promise<Array<[string, string]>> {
		return [];
	}
	async axChildren(_ref: string): Promise<AxNode[]> {
		return [];
	}
	async axParent(_ref: string): Promise<AxNode | null> {
		return null;
	}
	async axPerform(_ref: string, _action: string): Promise<void> {}
	async axSetValue(_ref: string, _value: string): Promise<void> {}
	async axFocus(_ref: string): Promise<void> {}
	async axClick(_ref: string, _opts?: PointerOptions | null): Promise<void> {}
	async close(): Promise<void> {
		this.closeCount += 1;
	}
}

class MemoryTransport implements ComputerWorkerTransport {
	readonly outbound: ComputerWorkerOutbound[] = [];
	#handler?: (message: ComputerWorkerInbound) => void;
	#waiters = new Set<{
		predicate: (message: ComputerWorkerOutbound) => boolean;
		resolve: (message: ComputerWorkerOutbound) => void;
	}>();

	send(message: ComputerWorkerOutbound): void {
		this.outbound.push(message);
		for (const waiter of this.#waiters) {
			if (!waiter.predicate(message)) continue;
			this.#waiters.delete(waiter);
			waiter.resolve(message);
		}
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
	waitFor(predicate: (message: ComputerWorkerOutbound) => boolean): Promise<ComputerWorkerOutbound> {
		const existing = this.outbound.find(predicate);
		if (existing) return Promise.resolve(existing);
		const pending = Promise.withResolvers<ComputerWorkerOutbound>();
		this.#waiters.add({ predicate, resolve: pending.resolve });
		return pending.promise;
	}
}

const snapshot = (readOnly = false, extra: Partial<ComputerSessionSnapshot> = {}): ComputerSessionSnapshot => ({
	cwd: import.meta.dir,
	sessionId: crypto.randomUUID(),
	captureMaxWidth: 1280,
	captureMaxHeight: 896,
	display: "all",
	backgroundFallback: "takeover",
	readOnly,
	...extra,
});

async function runWorker(
	transport: MemoryTransport,
	id: string,
	code: string,
	readOnly = false,
	timeoutMs = 2_000,
): Promise<Extract<ComputerWorkerOutbound, { type: "result" }>> {
	transport.inbound({ type: "run", id, code, timeoutMs, session: snapshot(readOnly) });
	return (await transport.waitFor(
		(message): message is Extract<ComputerWorkerOutbound, { type: "result" }> =>
			message.type === "result" && message.id === id,
	)) as Extract<ComputerWorkerOutbound, { type: "result" }>;
}

function toolSession(): ToolSession {
	return {
		cwd: import.meta.dir,
		hasUI: false,
		settings: Settings.isolated({ "computer.enabled": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	} as ToolSession;
}

const noOpController = {
	async run() {
		return { displays: [], returnValue: undefined, screenshots: [] };
	},
	async capabilities() {
		return undefined;
	},
	async close() {},
};

describe("computer schema and approval", () => {
	it("requires code, rejects unknown keys, and shares its lazily-created schema", async () => {
		const first = new ComputerTool(toolSession(), () => noOpController);
		const second = new ComputerTool(toolSession(), () => noOpController);
		const schema = first.parameters;

		expect(schema({ code: "await desktop.windows()" }) instanceof arkType.errors).toBe(false);
		expect(schema({}) instanceof arkType.errors).toBe(true);
		expect(schema({ code: "1", unexpected: true }) instanceof arkType.errors).toBe(true);
		expect(first.parameters).toBe(schema);
		expect(second.parameters).toBe(schema);
		await Promise.all([first.close(), second.close()]);
	});

	it("maps only literal read_only true to read approval", () => {
		expect(computerApproval({ read_only: true })).toBe("read");
		expect(computerApproval({})).toBe("exec");
		expect(computerApproval({ read_only: false })).toBe("exec");
		expect(computerApproval({ read_only: "yes" })).toBe("exec");
		expect(computerApproval("garbage")).toBe("exec");
	});
});

describe("computer worker round trips", () => {
	it("lists windows and returns screenshot caption, image, and detail through a fake native session", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, options => {
			expect(options).toEqual({ display: "all" });
			return native;
		});

		const result = await runWorker(
			transport,
			"capture",
			"const windows = await desktop.windows(); await desktop.screenshot(); ({ count: windows.length })",
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.payload.returnValue).toEqual({ count: 1 });
		const texts = result.payload.displays.filter(block => block.type === "text");
		const images = result.payload.displays.filter(block => block.type === "image");
		expect(texts).toHaveLength(1);
		expect(texts[0]?.text).toMatch(/^screenshot desktop 64×32 → .*omp-computer-.*\.png$/);
		expect(images).toEqual([{ type: "image", data: "iVBORw==", mimeType: "image/png" }]);
		expect(result.payload.screenshots).toHaveLength(1);
		expect(result.payload.screenshots[0]).toMatchObject({ width: 64, height: 32, target: "desktop" });
		expect(result.payload.screenshots[0]?.path).toMatch(/omp-computer-.*\.png$/);
	});

	it("reports source dimensions when a screenshot is scaled", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		native.sourceWidth = 128;
		native.sourceHeight = 64;
		new ComputerWorkerCore(transport, () => native);

		const result = await runWorker(transport, "scaled-capture", "await desktop.screenshot()");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.payload.displays[0]).toEqual(
			expect.objectContaining({
				type: "text",
				text: expect.stringMatching(/^screenshot desktop 64×32 \(scaled from 128×64\) → .*omp-computer-.*\.png$/),
			}),
		);
		expect(result.payload.screenshots[0]).toMatchObject({
			width: 64,
			height: 32,
			sourceWidth: 128,
			sourceHeight: 64,
		});
	});

	it("blocks read-only click after capture before invoking native input", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);

		const result = await runWorker(
			transport,
			"read-only",
			"await desktop.screenshot({ silent: true }); await desktop.click(1, 2)",
			true,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.isToolError).toBe(true);
		expect(result.error.message).toBe("read-only run: 'click' requires read_only: false");
		expect(native.clickCount).toBe(0);
	});

	it("rejects an aborted run with an abort error", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());
		transport.inbound({ type: "run", id: "abort", code: "await wait(5_000)", timeoutMs: 5_000, session: snapshot() });
		await Promise.resolve();
		transport.inbound({ type: "abort", id: "abort" });
		const result = await transport.waitFor(message => message.type === "result" && message.id === "abort");
		expect(result.type).toBe("result");
		if (result.type !== "result" || result.ok) return;
		expect(result.error.isAbort).toBe(true);
		expect(result.error.name).toBe("ToolAbortError");
	});

	it("reports the worker watchdog timeout budget explicitly", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());

		const result = await runWorker(transport, "timeout", "await wait(5_000)", false, 10);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatchObject({
			isToolError: true,
			message: "Computer code execution timed out after 10ms",
		});
	});

	it("round-trips tool calls and resolves the in-script promise", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());
		const resultPromise = runWorker(transport, "bridge", "await tool.echo({ value: 7 })");
		const call = await transport.waitFor(message => message.type === "tool-call" && message.runId === "bridge");
		expect(call).toMatchObject({ type: "tool-call", runId: "bridge", name: "echo", args: { value: 7 } });
		if (call.type !== "tool-call") return;
		transport.inbound({ type: "tool-reply", id: call.id, reply: { ok: true, value: { echoed: 7 } } });
		const result = await resultPromise;
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.payload.returnValue).toEqual({ echoed: 7 });
	});

	it("uses a retained window screenshot in the current run payload", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());

		const first = await runWorker(
			transport,
			"retain-window-screenshot",
			'globalThis.retainedWin = await desktop.window("42")',
		);
		expect(first.ok).toBe(true);
		const second = await runWorker(
			transport,
			"reuse-window-screenshot",
			"await globalThis.retainedWin.screenshot({ silent: true })",
		);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.payload.screenshots).toHaveLength(1);
		expect(second.payload.screenshots[0]).toMatchObject({
			width: 64,
			height: 32,
			sourceWidth: 64,
			sourceHeight: 32,
			target: "42",
		});
	});

	it("resolves ref() to a populated live element and find() to every match", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());
		const result = await runWorker(
			transport,
			"ref-resolve",
			'const win = await desktop.window("42"); const el = await win.ref("e1"); const all = await win.find({ role: "button" }); ({ role: el.role, count: all.length })',
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.payload.returnValue).toEqual({ role: "button", count: 1 });
	});

	it("applies the current read-only policy to a retained writable window", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);

		const first = await runWorker(
			transport,
			"retain-writable-window",
			'globalThis.retainedWin = await desktop.window("42")',
		);
		expect(first.ok).toBe(true);
		const second = await runWorker(
			transport,
			"reuse-window-read-only",
			"await globalThis.retainedWin.click(1, 1)",
			true,
		);
		expect(second.ok).toBe(false);
		if (second.ok) return;
		expect(second.error.message).toBe("read-only run: 'click' requires read_only: false");
		expect(native.clickCount).toBe(0);
	});

	it("allows a retained read-only window to mutate in a later exec run", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);

		const first = await runWorker(
			transport,
			"retain-read-only-window",
			'globalThis.retainedWin = await desktop.window("42")',
			true,
		);
		expect(first.ok).toBe(true);
		const second = await runWorker(
			transport,
			"reuse-window-exec",
			"await globalThis.retainedWin.screenshot({ silent: true }); await globalThis.retainedWin.click(1, 1)",
		);
		expect(second.ok).toBe(true);
		expect(native.clickCount).toBe(1);
	});

	it("denies async continuations leaked from an ended run the next run's authority", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);

		// Run 1 (exec) leaks a promise continuation that clicks once triggered.
		// The continuation is registered inside run 1's async context, so it must
		// retain run 1's (aborted) context even when it executes during run 2.
		const first = await runWorker(
			transport,
			"leak-continuation",
			[
				'globalThis.leakWin = await desktop.window("42");',
				"globalThis.leakErr = null;",
				"const { promise: trigger, resolve: fireLeak } = Promise.withResolvers(); globalThis.fireLeak = fireLeak;",
				"globalThis.leakDone = trigger.then(() => globalThis.leakWin.click(1, 1)).catch(err => { globalThis.leakErr = String(err); });",
				'"armed"',
			].join("\n"),
		);
		expect(first.ok).toBe(true);
		// Run 2 (exec) fires the leaked continuation and awaits its settlement; the
		// click must fail with run 1's abort instead of borrowing run 2's policy.
		const second = await runWorker(
			transport,
			"leak-victim",
			"globalThis.fireLeak(); await globalThis.leakDone; globalThis.leakErr",
		);
		expect(second.ok).toBe(true);
		if (second.ok) expect(String(second.payload.returnValue)).toContain("Computer run ended");
		expect(native.clickCount).toBe(0);
	});

	it("uses a retained AX element in the current run", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());

		const first = await runWorker(
			transport,
			"retain-element",
			'globalThis.retainedEl = (await (await desktop.window("42")).find({ role: "button" }))[0]',
		);
		expect(first.ok).toBe(true);
		const second = await runWorker(transport, "reuse-element", "await globalThis.retainedEl.bounds()");
		expect(second.ok).toBe(true);
		if (second.ok) expect(second.payload.returnValue).toEqual({ x: 7, y: 8, width: 9, height: 10 });
	});
});

class SupervisorWorker implements ComputerWorkerHandle {
	readonly #respond: boolean;
	#messageHandlers = new Set<(message: ComputerWorkerOutbound) => void>();
	#terminated = false;

	constructor(respond: boolean) {
		this.#respond = respond;
	}
	send(message: ComputerWorkerInbound): void {
		if (message.type === "run" && this.#respond) {
			queueMicrotask(() =>
				this.#emit({
					type: "result",
					id: message.id,
					ok: true,
					payload: { displays: [], returnValue: "fresh", screenshots: [], capabilities },
				}),
			);
		} else if (message.type === "close") {
			queueMicrotask(() => this.#emit({ type: "closed" }));
		}
	}
	onMessage(handler: (message: ComputerWorkerOutbound) => void): () => void {
		this.#messageHandlers.add(handler);
		queueMicrotask(() => this.#emit({ type: "ready" }));
		return () => this.#messageHandlers.delete(handler);
	}
	onError(_handler: (error: Error) => void): () => void {
		return () => {};
	}
	async terminate(): Promise<void> {
		this.#terminated = true;
	}
	#emit(message: ComputerWorkerOutbound): void {
		if (this.#terminated) return;
		for (const handler of this.#messageHandlers) handler(message);
	}
}

describe("computer supervisor recovery", () => {
	it("surfaces a timeout ToolError and creates a fresh worker for the next run", async () => {
		let workers = 0;
		const supervisor = new ComputerSupervisor(toolSession(), () => new SupervisorWorker(++workers > 1), {
			startMs: 200,
			closeMs: 200,
		});
		await expect(supervisor.run("await new Promise(() => {})", 5, snapshot())).rejects.toEqual(
			expect.objectContaining({
				name: "ToolError",
				message: "computer worker restarted; captures and ax refs were reset",
			}),
		);
		const result = await supervisor.run("41 + 1", 1_000, snapshot());
		expect(result.returnValue).toBe("fresh");
		expect(workers).toBe(2);
		await supervisor.close();
	});
});

describe("native application catalogue", () => {
	const notion = {
		id: "C:Start MenuNotion.lnk",
		name: "Notion",
		path: "C:Start MenuNotion.lnk",
		running: true,
		pid: 4242,
	};

	it("prefers the addon's inventory and maps it onto the desktop shape", async () => {
		const transport = new MemoryTransport();
		const session = new FakeNativeSession();
		const asked: Array<{ query?: string | null } | undefined> = [];
		session.listApplications = async query => {
			asked.push(query);
			return [notion];
		};
		new ComputerWorkerCore(transport, () => session);

		const result = await runWorker(transport, "apps", "return await desktop.apps({ name: 'not' });");
		expect(result.ok).toBe(true);
		const apps = result.ok ? (result.payload.returnValue as unknown[]) : [];
		expect(apps).toEqual([
			{ id: notion.id, name: "Notion", path: notion.path, kind: "shortcut", running: true, pid: 4242 },
		]);
		expect(asked).toEqual([{ query: "not" }]);
	});

	it("launches through the addon so the platform owns the handler", async () => {
		const transport = new MemoryTransport();
		const session = new FakeNativeSession();
		let target: string | undefined;
		session.openApplication = async value => {
			target = value;
			return notion;
		};
		new ComputerWorkerCore(transport, () => session);

		const result = await runWorker(transport, "launch", "return await desktop.launch('Notion');");
		expect(result.ok).toBe(true);
		expect(result.ok ? result.payload.returnValue : null).toEqual({ pid: 4242, path: notion.path });
		expect(target).toBe("Notion");
	});
});

describe("application catalogue provider seam", () => {
	it("routes desktop.apps through the host provider named by the run", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());
		transport.inbound({
			type: "run",
			id: "prov-list",
			code: "return await desktop.apps({ name: 'notion' });",
			timeoutMs: 2_000,
			session: snapshot(false, { applicationProvider: "test-catalogue" }),
		});
		const call = await transport.waitFor(message => message.type === "provider-call");
		if (call.type !== "provider-call") throw new Error("expected a provider call");
		expect(call.provider).toBe("applications");
		expect(call.method).toBe("list");
		expect(call.args).toEqual({ query: "notion" });

		transport.inbound({
			type: "provider-reply",
			id: call.id,
			reply: {
				ok: true,
				value: [
					{ id: "C:aNotion.lnk", name: "Notion", path: "C:aNotion.lnk", kind: "native", running: true, pid: 7 },
				],
			},
		});
		const result = (await transport.waitFor(
			message => message.type === "result" && message.id === "prov-list",
		)) as Extract<ComputerWorkerOutbound, { type: "result" }>;
		expect(result.ok).toBe(true);
		expect(result.ok ? result.payload.returnValue : null).toEqual([
			{ id: "C:aNotion.lnk", name: "Notion", path: "C:aNotion.lnk", kind: "native", running: true, pid: 7 },
		]);
	});

	it("surfaces a provider failure instead of falling back silently", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());
		transport.inbound({
			type: "run",
			id: "prov-fail",
			code: "return await desktop.apps();",
			timeoutMs: 2_000,
			session: snapshot(false, { applicationProvider: "test-catalogue" }),
		});
		const call = await transport.waitFor(message => message.type === "provider-call");
		if (call.type !== "provider-call") throw new Error("expected a provider call");
		transport.inbound({
			type: "provider-reply",
			id: call.id,
			reply: {
				ok: false,
				error: { name: "ToolError", message: "catalogue offline", isToolError: true, isAbort: false },
			},
		});
		const result = (await transport.waitFor(
			message => message.type === "result" && message.id === "prov-fail",
		)) as Extract<ComputerWorkerOutbound, { type: "result" }>;
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toContain("catalogue offline");
	});

	it("uses the built-in catalogue when the run names no provider", async () => {
		const transport = new MemoryTransport();
		const session = new FakeNativeSession();
		let nativeAsked = false;
		session.listApplications = async () => {
			nativeAsked = true;
			return [];
		};
		new ComputerWorkerCore(transport, () => session);
		const result = await runWorker(transport, "builtin", "return await desktop.apps();");
		expect(result.ok).toBe(true);
		expect(nativeAsked).toBe(true);
	});
});

class ProviderCallWorker implements ComputerWorkerHandle {
	#handlers = new Set<(message: ComputerWorkerOutbound) => void>();
	#runId = "";

	send(message: ComputerWorkerInbound): void {
		if (message.type === "run") {
			this.#runId = message.id;
			queueMicrotask(() =>
				this.#emit({
					type: "provider-call",
					id: "provider-call-1",
					provider: "applications",
					method: "list",
					args: { query: "x" },
				}),
			);
			return;
		}
		if (message.type === "provider-reply") {
			queueMicrotask(() =>
				this.#emit({
					type: "result",
					id: this.#runId,
					ok: true,
					payload: { displays: [], returnValue: { reply: message.reply }, screenshots: [] },
				}),
			);
			return;
		}
		if (message.type === "close") queueMicrotask(() => this.#emit({ type: "closed" }));
	}
	onMessage(handler: (message: ComputerWorkerOutbound) => void): () => void {
		this.#handlers.add(handler);
		queueMicrotask(() => this.#emit({ type: "ready" }));
		return () => this.#handlers.delete(handler);
	}
	onError(_handler: (error: Error) => void): () => void {
		return () => {};
	}
	async terminate(): Promise<void> {}
	#emit(message: ComputerWorkerOutbound): void {
		for (const handler of this.#handlers) handler(message);
	}
}

describe("supervisor application provider dispatch", () => {
	it("answers the worker with the registered provider's result", async () => {
		const { ApplicationProviderRegistry } = await import("../../src/tools/computer/app-provider");
		const registry = new ApplicationProviderRegistry();
		const calls: unknown[] = [];
		registry.register({
			name: "test-catalogue",
			async list(args) {
				calls.push(args);
				return [{ id: "/a/x.lnk", name: "X", path: "/a/x.lnk", kind: "native" }];
			},
			async open() {
				return { path: "/a/x.lnk" };
			},
		});
		const supervisor = new ComputerSupervisor(
			toolSession(),
			() => new ProviderCallWorker(),
			{ startMs: 200, closeMs: 200 },
			async () => {
				throw new Error("tool bridge unused");
			},
			registry,
		);

		const result = await supervisor.run(
			"await desktop.apps()",
			1_000,
			snapshot(false, { applicationProvider: "test-catalogue" }),
		);
		expect(calls).toEqual([{ query: "x" }]);
		expect(result.returnValue).toMatchObject({
			reply: { ok: true, value: [{ id: "/a/x.lnk", name: "X", path: "/a/x.lnk", kind: "native" }] },
		});
		await supervisor.close();
	});

	it("refuses the call when no provider is registered", async () => {
		const { ApplicationProviderRegistry } = await import("../../src/tools/computer/app-provider");
		const supervisor = new ComputerSupervisor(
			toolSession(),
			() => new ProviderCallWorker(),
			{ startMs: 200, closeMs: 200 },
			async () => {
				throw new Error("tool bridge unused");
			},
			new ApplicationProviderRegistry(),
		);

		const result = await supervisor.run("await desktop.apps()", 1_000, snapshot());
		expect(result.returnValue).toMatchObject({
			reply: { ok: false, error: { message: "No application catalogue provider is registered" } },
		});
		await supervisor.close();
	});
});

describe("application catalogue filters", () => {
	it("forwards runningOnly and activate to the catalogue seam", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());
		transport.inbound({
			type: "run",
			id: "prov-filter",
			code: "return await desktop.apps({ runningOnly: true });",
			timeoutMs: 2_000,
			session: snapshot(false, { applicationProvider: "test-catalogue" }),
		});
		const listCall = await transport.waitFor(message => message.type === "provider-call");
		if (listCall.type !== "provider-call") throw new Error("expected a provider call");
		expect(listCall.args).toEqual({ runningOnly: true });
		transport.inbound({ type: "provider-reply", id: listCall.id, reply: { ok: true, value: [] } });
		const listResult = (await transport.waitFor(
			message => message.type === "result" && message.id === "prov-filter",
		)) as Extract<ComputerWorkerOutbound, { type: "result" }>;
		expect(listResult.ok).toBe(true);

		transport.inbound({
			type: "run",
			id: "prov-open",
			code: "return await desktop.launch('Notion', { activate: true });",
			timeoutMs: 2_000,
			session: snapshot(false, { applicationProvider: "test-catalogue" }),
		});
		const openCall = await transport.waitFor(
			message => message.type === "provider-call" && message.method === "open",
		);
		if (openCall.type !== "provider-call") throw new Error("expected a provider call");
		expect(openCall.method).toBe("open");
		expect(openCall.args).toEqual({ target: "Notion", activate: true });
		transport.inbound({
			type: "provider-reply",
			id: openCall.id,
			reply: { ok: true, value: { path: "C:aNotion.lnk", pid: 9 } },
		});
		const openResult = (await transport.waitFor(
			message => message.type === "result" && message.id === "prov-open",
		)) as Extract<ComputerWorkerOutbound, { type: "result" }>;
		expect(openResult.ok).toBe(true);
		expect(openResult.ok ? openResult.payload.returnValue : null).toEqual({ path: "C:aNotion.lnk", pid: 9 });
	});
});

describe("native window menus", () => {
	it("lists a level and selects a command through the addon", async () => {
		const transport = new MemoryTransport();
		const session = new FakeNativeSession();
		const listed: string[][] = [];
		const selected: string[][] = [];
		session.menuItems = async (_window, path) => {
			listed.push(path);
			return [
				{
					title: "Open…",
					path: [...path, "Open…"],
					enabled: true,
					checked: false,
					has_submenu: false,
					shortcut: "Ctrl+O",
				},
			];
		};
		session.menuSelect = async (_window, path) => {
			selected.push(path);
		};
		new ComputerWorkerCore(transport, () => session);

		const listedResult = await runWorker(
			transport,
			"menu-list",
			"return await (await desktop.window('42')).menu(['File']);",
		);
		expect(listedResult.ok).toBe(true);
		expect(listedResult.ok ? listedResult.payload.returnValue : null).toEqual([
			{
				title: "Open…",
				path: ["File", "Open…"],
				enabled: true,
				checked: false,
				has_submenu: false,
				shortcut: "Ctrl+O",
			},
		]);
		expect(listed).toEqual([["File"]]);

		const selectResult = await runWorker(
			transport,
			"menu-select",
			"return await (await desktop.window('42')).menuSelect(['File', 'Open']);",
		);
		expect(selectResult.ok).toBe(true);
		expect(selected).toEqual([["File", "Open"]]);
	});

	it("refuses a menu command in a read-only run", async () => {
		const transport = new MemoryTransport();
		const session = new FakeNativeSession();
		session.menuSelect = async () => {};
		new ComputerWorkerCore(transport, () => session);
		const result = await runWorker(
			transport,
			"menu-readonly",
			"return await (await desktop.window('42')).menuSelect(['File', 'Open']);",
			true,
		);
		expect(result.ok).toBe(false);
	});
});
