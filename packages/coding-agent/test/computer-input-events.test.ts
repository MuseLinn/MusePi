// Computer worker input-event streaming: the glow overlay's upstream
// half. Runs real desktop scripts against a mock native session and
// asserts the ComputerInputEvent messages the worker emits per input
// action (kind, target frame, scaled click point).
import { test, expect } from "bun:test";
import {
	ComputerWorkerCore,
	type NativeDesktopSession,
	type NativeDesktopSessionFactory,
} from "../src/tools/computer/worker";
import type { ComputerWorkerInbound, ComputerWorkerOutbound, ComputerWorkerTransport } from "../src/tools/computer/protocol";

const WINDOW: Record<string, { x: number; y: number; width: number; height: number }> = {
	"win-1": { x: 100, y: 200, width: 800, height: 600 },
	"win-2": { x: 1200, y: 100, width: 400, height: 300 },
};

function makeHarness(code: string) {
	const sent: ComputerWorkerOutbound[] = [];
	const nativeCalls: string[] = [];
	// Every native method returns a resolved no-op; capture() and
	// listWindows()/axNode() return the data the script needs.
	const session = new Proxy({} as NativeDesktopSession, {
		get(_target, prop: string | symbol) {
			const name = String(prop);
			return (...args: unknown[]) => {
				nativeCalls.push(`${name}(${args.map(a => JSON.stringify(a)).join(",")})`);
				switch (name) {
					case "capture":
						return {
							data: new Uint8Array(4),
							width: 640,
							height: 480,
							sourceWidth: 1280,
							sourceHeight: 960,
							target: args[0],
						};
					case "listWindows":
						return [
							{ id: "win-1", app: "Notes", title: "Notes — 文档", ...WINDOW["win-1"], focused: true },
							{ id: "win-2", app: "Mail", title: "Mail", ...WINDOW["win-2"], focused: false },
						];
					case "axNode":
					case "axQuery":
					case "axFocused":
					case "axElementAt":
						return [
							{
								ref: "e1",
								role: "AXButton",
								title: "Save",
								x: 300,
								y: 400,
								width: 60,
								height: 24,
								enabled: true,
								focused: false,
								childCount: 0,
								value: undefined,
								actions: ["AXPress"],
							},
						].slice(0, name === "axQuery" ? undefined : 1)[0];
					case "axChildren":
					case "axParent":
						return [];
					case "axAttributes":
						return [];
					default:
						return undefined;
				}
			};
		},
	}) as NativeDesktopSession;
	const factory: NativeDesktopSessionFactory = () => session;
	const transport: ComputerWorkerTransport = {
		send(message) {
			sent.push(message);
		},
		onMessage() {
			return () => {};
		},
		close() {},
	};
	const core = new ComputerWorkerCore(transport, factory);
	const inputs = () =>
		sent
			.filter((m): m is Extract<ComputerWorkerOutbound, { type: "input" }> => m.type === "input")
			.map(m => m.event);
	const run = async (): Promise<void> => {
		const message: Extract<ComputerWorkerInbound, { type: "run" }> = {
			type: "run",
			id: "r1",
			code,
			timeoutMs: 10_000,
			session: {
				cwd: "/tmp",
				sessionId: "s1",
				captureMaxWidth: 1280,
				captureMaxHeight: 960,
				display: "all",
				readOnly: false,
			},
		};
		core.handle(message);
		// Wait for the run result to settle.
		for (let i = 0; i < 200 && !sent.some(m => m.type === "result"); i++) {
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		expect(sent.some(m => m.type === "result")).toBe(true);
	};
	return { run, inputs, nativeCalls };
}

test("click emits target frame + scaled screen point", async () => {
	const h = await makeHarness(
		`const w = await desktop.window("win-1"); await w.screenshot({silent:true}); w.click(320, 240);`,
	);
	await h.run();
	const events = h.inputs();
	expect(events).toHaveLength(1);
	const e = events[0]!;
	expect(e.kind).toBe("click");
	expect(e.app).toBe("Notes");
	expect(e.title).toBe("Notes — 文档");
	// win-1 bounds (100,200,800,600); screenshot 640x480 → scale 800/640=1.25
	expect(e.rect).toEqual({ x: 100, y: 200, width: 800, height: 600 });
	expect(e.point).toEqual({ x: 100 + Math.round(320 * 1.25), y: 200 + Math.round(240 * 1.25) });
});

test("per-target screenshot sizes keep scaling correct across windows", async () => {
	const h = await makeHarness(
		`const w = await desktop.window("win-1"); await w.screenshot({silent:true}); w.click(320, 240); const w2 = await desktop.window("win-2"); w2.click(200, 150);`,
	);
	await h.run();
	const [a, b] = h.inputs();
	// win-1: screenshot 640x480, bounds 800x600 → 1.25
	expect(a!.point).toEqual({ x: 100 + 400, y: 200 + 300 });
	// win-2: SAME screenshot baseline would be wrong if shotSizes were
	// run-global (640x480 from win-1) — per-target must fall back to
	// scaling onto win-2's bounds via... no shot for win-2 → point omitted.
	expect(b!.kind).toBe("click");
	expect(b!.rect).toEqual({ x: 1200, y: 100, width: 400, height: 300 });
	expect(b!.point).toBeUndefined();
});

test("type/press/scroll/raise emit kinds without points", async () => {
	const h = await makeHarness(
		`const w = await desktop.window("win-1"); w.type("hello"); w.press("cmd+s"); w.scroll(100, 100, {dy: 200}); w.raise();`,
	);
	await h.run();
	const kinds = h.inputs().map(e => e.kind);
	expect(kinds).toEqual(["type", "press", "scroll", "raise"]);
	for (const e of h.inputs()) {
		expect(e.rect).toEqual({ x: 100, y: 200, width: 800, height: 600 });
		expect(e.point).toBeUndefined();
	}
});

test("ax element actions emit element bounds", async () => {
	const h = await makeHarness(
		`const el = await desktop.focusedElement(); await el.click();`,
	);
	await h.run();
	const events = h.inputs();
	expect(events).toHaveLength(1);
	expect(events[0]!.kind).toBe("click");
	// element bounds from the mock axNode (global coords)
	expect(events[0]!.rect).toEqual({ x: 300, y: 400, width: 60, height: 24 });
});

test("read_only runs emit no input events", async () => {
	const sent: ComputerWorkerOutbound[] = [];
	const session = new Proxy({} as NativeDesktopSession, {
		get() {
			return (..._args: unknown[]) => undefined;
		},
	});
	const core = new ComputerWorkerCore(
		{ send: m => sent.push(m), onMessage: () => () => {}, close() {} },
		() => session,
	);
	core.handle({
		type: "run",
		id: "r2",
		code: `const w = await desktop.window("win-1"); w.click(10, 10);`,
		timeoutMs: 10_000,
		session: { cwd: "/tmp", sessionId: "s2", captureMaxWidth: 1280, captureMaxHeight: 960, display: "all", readOnly: true },
	});
	for (let i = 0; i < 200 && !sent.some(m => m.type === "result"); i++) {
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	expect(sent.some(m => m.type === "input")).toBe(false);
});
