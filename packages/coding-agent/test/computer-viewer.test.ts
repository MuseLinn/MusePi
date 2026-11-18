// Computer viewer (picture-in-picture) contract: preview frames ride the
// tool-update bypass, never the model-visible output, and no preview capture
// is issued unless the session asked for one.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { ComputerTool, type ToolSession } from "@musepi/pi-coding-agent/tools";
import type { DesktopCapabilities, DesktopWindow } from "@musepi/pi-natives";
import { AppendJournal } from "../src/daemon/journal";
import {
	type ComputerWorkerInbound,
	type ComputerWorkerOutbound,
	type ComputerWorkerTransport,
	VIEWER_FRAME_MAX_EDGE,
} from "../src/tools/computer/protocol";
import type { ComputerController } from "../src/tools/computer/supervisor";
import {
	ComputerWorkerCore,
	type NativeDesktopSession,
	type NativeDesktopSessionFactory,
} from "../src/tools/computer/worker";

const capabilities: DesktopCapabilities = {
	backend: "fake",
	displayServer: "memory",
	capture: true,
	input: true,
	ax: false,
	backgroundWindowInput: true,
	overlay: false,
	deliveryModes: ["background"],
	capturePermission: "granted",
	inputPermission: "granted",
	axPermission: "unavailable",
	displayCount: 1,
};

interface Captured {
	target: string;
	maxWidth?: number;
	maxHeight?: number;
}

interface SessionDouble {
	session: NativeDesktopSession;
	captures: Captured[];
	closed: boolean[];
}

const WINDOWS: DesktopWindow[] = [
	{ id: "win-1", title: "Notes", app: "Notes", pid: 1, x: 0, y: 0, width: 800, height: 600, focused: true },
];

/** Native session double: records every capture and close, nothing else. */
function sessionDouble(): SessionDouble {
	const captures: Captured[] = [];
	const closed: boolean[] = [];
	const session = {
		capabilities,
		capture(target: string, caps?: { maxWidth?: number; maxHeight?: number }) {
			captures.push({ target, maxWidth: caps?.maxWidth, maxHeight: caps?.maxHeight });
			const width = Math.min(VIEWER_FRAME_MAX_EDGE, caps?.maxWidth ?? VIEWER_FRAME_MAX_EDGE);
			const height = Math.min(300, caps?.maxHeight ?? 300);
			return Promise.resolve({
				data: new Uint8Array([137, 80, 78, 71]),
				width,
				height,
				sourceWidth: width,
				sourceHeight: height,
				target,
			});
		},
		listWindows() {
			return Promise.resolve(WINDOWS);
		},
		close() {
			closed.push(true);
			return Promise.resolve();
		},
	} as unknown as NativeDesktopSession;
	return { session, captures, closed };
}

function makeHarness(code: string, viewer: boolean | undefined) {
	const sent: ComputerWorkerOutbound[] = [];
	const sessions: SessionDouble[] = [];
	const factory: NativeDesktopSessionFactory = () => {
		const created = sessionDouble();
		sessions.push(created);
		return created.session;
	};
	const core = new ComputerWorkerCore(
		{ send: message => sent.push(message), onMessage: () => () => {}, close() {} } satisfies ComputerWorkerTransport,
		factory,
	);
	const run = async (): Promise<void> => {
		const message: Extract<ComputerWorkerInbound, { type: "run" }> = {
			type: "run",
			id: "viewer-run",
			code,
			timeoutMs: 10_000,
			session: {
				cwd: "/tmp",
				sessionId: "viewer-session",
				captureMaxWidth: 1280,
				captureMaxHeight: 960,
				display: "all",
				backgroundFallback: "takeover",
				readOnly: false,
				...(viewer === undefined ? {} : { viewer }),
			},
		};
		core.handle(message);
		for (let i = 0; i < 400 && !sent.some(m => m.type === "result"); i++) {
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		expect(sent.some(m => m.type === "result")).toBe(true);
	};
	const frames = () => sent.filter((m): m is Extract<ComputerWorkerOutbound, { type: "frame" }> => m.type === "frame");
	const result = () => sent.find((m): m is Extract<ComputerWorkerOutbound, { type: "result" }> => m.type === "result");
	return { run, frames, result, sessions };
}

const settle = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

describe("computer viewer frames", () => {
	test("streams throttled previews from a preview session, never touching the run session", async () => {
		const h = makeHarness(`await wait(1200);`, true);
		await h.run();

		const frames = h.frames();
		expect(frames.length).toBeGreaterThanOrEqual(2);
		for (const message of frames) {
			expect(message.runId).toBe("viewer-run");
			expect(message.frame.mimeType).toBe("image/png");
			expect(message.frame.target).toBe("desktop");
			expect(message.frame.width).toBeLessThanOrEqual(VIEWER_FRAME_MAX_EDGE);
			expect(message.frame.height).toBeLessThanOrEqual(VIEWER_FRAME_MAX_EDGE);
			expect(Buffer.from(message.frame.data, "base64")).toEqual(Buffer.from([137, 80, 78, 71]));
		}

		// Two sessions: the run's own, then the preview session. The run's
		// session must never be captured — a capture would replace the
		// coordinate frame pointer input is mapped against.
		expect(h.sessions).toHaveLength(2);
		expect(h.sessions[0]!.captures).toHaveLength(0);
		expect(h.sessions[1]!.captures.length).toBeGreaterThanOrEqual(2);
		for (const capture of h.sessions[1]!.captures) {
			expect(capture.maxWidth).toBe(VIEWER_FRAME_MAX_EDGE);
			expect(capture.maxHeight).toBe(VIEWER_FRAME_MAX_EDGE);
		}
		// The preview session is closed with the run.
		expect(h.sessions[1]!.closed).toHaveLength(1);
	});

	test("no viewer flag issues no preview capture at all", async () => {
		const h = makeHarness(`await wait(1200);`, undefined);
		await h.run();
		expect(h.frames()).toHaveLength(0);
		expect(h.sessions).toHaveLength(1);
		expect(h.sessions[0]!.captures).toHaveLength(0);
	});

	test("viewer: false issues no preview capture at all", async () => {
		const h = makeHarness(`await wait(1200);`, false);
		await h.run();
		expect(h.frames()).toHaveLength(0);
		expect(h.sessions).toHaveLength(1);
		expect(h.sessions[0]!.captures).toHaveLength(0);
	});

	test("frames stop when the run ends and never enter the run output", async () => {
		const h = makeHarness(`await wait(700);`, true);
		await h.run();
		const afterRun = h.frames().length;
		expect(afterRun).toBeGreaterThanOrEqual(1);
		await settle(700);
		expect(h.frames()).toHaveLength(afterRun);
		const payload = h.result()!;
		expect(payload.ok).toBe(true);
		if (payload.ok) expect(payload.payload.displays).toEqual([]);
	});

	test("the preview follows the last model-visible screenshot target", async () => {
		const h = makeHarness(
			`const w = await desktop.window("win-1"); await w.screenshot({silent:true}); await wait(1000);`,
			true,
		);
		await h.run();
		expect(h.sessions).toHaveLength(2);
		const preview = h.sessions[1]!;
		expect(preview.captures.length).toBeGreaterThanOrEqual(2);
		// The first tick may land before the screenshot; every later tick follows
		// the target the model last looked at.
		expect(preview.captures.at(-1)!.target).toBe("win-1");
	});
});

describe("computer tool viewer details", () => {
	function toolSession(
		surface: { hasUI: boolean; viewerSurface: boolean },
		settings: Record<string, unknown> = {},
	): ToolSession {
		return {
			cwd: "/tmp",
			hasUI: surface.hasUI,
			viewerSurface: surface.viewerSurface,
			settings: Settings.isolated({ "computer.enabled": true, ...settings }),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
		} as ToolSession;
	}

	// Only the rpc-ui daemon renders previews; the TUI is hasUI but has no
	// preview surface, and headless runs have neither.
	const DAEMON = { hasUI: true, viewerSurface: true };
	const TUI = { hasUI: true, viewerSurface: false };
	const HEADLESS = { hasUI: false, viewerSurface: false };

	function controller(record: { snapshot?: { viewer?: boolean } }): ComputerController {
		return {
			async run(_code, _timeoutMs, snapshot, _signal, _onInput, onViewerFrame) {
				record.snapshot = snapshot;
				onViewerFrame?.({
					data: "iVBORw0KGgo=",
					mimeType: "image/png",
					width: 480,
					height: 300,
					target: "desktop",
					at: 1,
				});
				return { displays: [{ type: "text" as const, text: "ok" }], returnValue: undefined, screenshots: [] };
			},
			async capabilities() {
				return undefined;
			},
			async close() {},
		};
	}

	test("frames reach details.viewer and never the result content", async () => {
		const updates: Array<{ content: unknown[]; details?: { viewer?: { data: string } } }> = [];
		const record: { snapshot?: { viewer?: boolean } } = {};
		const tool = new ComputerTool(toolSession(DAEMON), () => controller(record));
		const result = await tool.execute("t1", { code: "await wait(1)" }, undefined, partial => {
			updates.push(partial as never);
		});
		await tool.close();

		expect(record.snapshot?.viewer).toBe(true);
		const viewerUpdates = updates.filter(update => update.details?.viewer !== undefined);
		expect(viewerUpdates).toHaveLength(1);
		expect(viewerUpdates[0]!.content).toEqual([]);
		expect(viewerUpdates[0]!.details!.viewer!.data).toBe("iVBORw0KGgo=");
		// The model-visible result carries the run's own text only.
		expect(result.content).toEqual([{ type: "text", text: "ok" }]);
	});

	test("computer.viewer: false asks for no previews", async () => {
		const record: { snapshot?: { viewer?: boolean } } = {};
		const tool = new ComputerTool(toolSession(DAEMON, { "computer.viewer": false }), () => controller(record));
		await tool.execute("t2", { code: "await wait(1)" }, undefined, () => {});
		await tool.close();
		expect(record.snapshot?.viewer).toBe(false);
	});

	test("no update callback means no viewer subscriber", async () => {
		const record: { snapshot?: { viewer?: boolean } } = {};
		const tool = new ComputerTool(toolSession(DAEMON), () => controller(record));
		await tool.execute("t3", { code: "await wait(1)" });
		await tool.close();
		expect(record.snapshot?.viewer).toBe(false);
	});

	test("the TUI has UI but no preview surface", async () => {
		const record: { snapshot?: { viewer?: boolean } } = {};
		const tool = new ComputerTool(toolSession(TUI), () => controller(record));
		await tool.execute("t4", { code: "await wait(1)" }, undefined, () => {});
		await tool.close();
		expect(record.snapshot?.viewer).toBe(false);
	});

	test("headless sessions ask for no previews", async () => {
		const record: { snapshot?: { viewer?: boolean } } = {};
		const tool = new ComputerTool(toolSession(HEADLESS), () => controller(record));
		await tool.execute("t5", { code: "await wait(1)" }, undefined, () => {});
		await tool.close();
		expect(record.snapshot?.viewer).toBe(false);
	});
});

describe("computer viewer journal", () => {
	test("the journal drops preview frames while the broadcast event keeps them", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-viewer-journal-"));
		const journal = new AppendJournal(dir, "viewer-session");
		try {
			await journal.open();
			// The same object the daemon broadcasts to subscribers.
			const event = {
				type: "tool_execution_update" as const,
				toolCallId: "call-1",
				toolName: "computer",
				args: {},
				partialResult: {
					content: [],
					details: {
						screenshots: [],
						inputEvents: [{ kind: "click" }],
						viewer: { data: "A".repeat(170_000), mimeType: "image/png", width: 480, height: 300 },
					},
				},
			};
			journal.append(event);
			await journal.flush();

			const record = JSON.parse(fs.readFileSync(journal.filePath, "utf8").trim()) as {
				event: { partialResult: { details: Record<string, unknown> } };
			};
			// On disk: no frame, everything else intact.
			expect(record.event.partialResult.details.viewer).toBeUndefined();
			expect(record.event.partialResult.details.inputEvents).toEqual([{ kind: "click" }]);
			// The broadcast payload was not mutated by the journal.
			expect((event.partialResult.details as { viewer?: { data: string } }).viewer?.data.length).toBe(170_000);
		} finally {
			await journal.close();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
