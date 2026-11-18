import type { ImageContent, TextContent } from "@musepi/pi-ai";
import type { DesktopCapabilities } from "@musepi/pi-natives";

/** Hidden CLI selector that re-enters the computer worker host. */
export const COMPUTER_WORKER_ARG = "__musepi_worker_computer";

/** Cadence of the GUI picture-in-picture preview (~2 fps). */
export const VIEWER_FRAME_INTERVAL_MS = 500;

/** Long-edge cap of one viewer frame, in pixels. */
export const VIEWER_FRAME_MAX_EDGE = 480;

/** Consecutive preview failures before the viewer gives up for the run. */
export const VIEWER_MAX_FAILURES = 5;

/** Reported provider name when the worker's own desktop session answers. */
export const BUILTIN_COMPUTER_PROVIDER = "builtin";

/** Frozen run settings transferred from the tool session to the worker. */
export interface ComputerSessionSnapshot {
	cwd: string;
	sessionId: string;
	captureMaxWidth: number;
	captureMaxHeight: number;
	display: string;
	readOnly: boolean;
	/** `computer.backgroundFallback`: may an action take the user's focus when
	 *  a window refuses background input, or must it fail instead? */
	backgroundFallback: "takeover" | "refuse";
	/** Host-registered application catalogue provider, when one replaced the
	 *  worker's built-in source for this run. */
	applicationProvider?: string | null;
	/** Provider accepting computer use for this run: a host slot name, or
	 *  `builtin` when the slot is empty or its incumbent is releasing. */
	computerProvider?: string;
	/** Stream throttled preview frames for the GUI picture-in-picture. False
	 *  (and absent) means the worker never issues a preview capture. */
	viewer?: boolean;
}

/** Reply envelope for a session tool invoked by desktop JavaScript. */
export type ToolReply = { ok: true; value: unknown } | { ok: false; error: RunErrorPayload };

/** Commands accepted by the persistent computer worker. */
export type ComputerWorkerInbound =
	| { type: "ping"; id: string }
	| { type: "run"; id: string; code: string; timeoutMs: number; session: ComputerSessionSnapshot }
	| { type: "abort"; id: string }
	| { type: "tool-reply"; id: string; reply: ToolReply }
	| { type: "provider-reply"; id: string; reply: ToolReply }
	| { type: "close" };

/** Successful computer run output returned to the tool supervisor. */
export interface ComputerRunOk {
	displays: Array<TextContent | ImageContent>;
	returnValue: unknown;
	screenshots: ComputerScreenshot[];
	capabilities?: DesktopCapabilities;
}

/**
 * One desktop input action performed by the agent during a run
 * (click/type/press/…). Streamed to the tool session's update callback
 * so the GUI can highlight the operation target; never part of the
 * model-visible output.
 */
export interface ComputerInputEvent {
	/** Action performed (matches the desktop API method names). */
	kind:
		| "click"
		| "doubleClick"
		| "move"
		| "drag"
		| "scroll"
		| "type"
		| "press"
		| "raise"
		| "setValue"
		| "perform"
		| "focus";
	/** Target app name when the action targets a specific window. */
	app?: string;
	/** Target window title when the action targets a specific window. */
	title?: string;
	/** Target frame in global screen coords — window bounds for Win
	 *  actions, element bounds for AX actions. Omitted for desktop-wide
	 *  input with no specific target. */
	rect?: { x: number; y: number; width: number; height: number };
	/** Best-effort action point in global screen coords (click coords
	 *  are screenshot pixels scaled onto the window bounds). */
	point?: { x: number; y: number };
}

/** Full-resolution screenshot emitted during one computer run. */
export interface ComputerScreenshot {
	path: string;
	width: number;
	height: number;
	sourceWidth?: number;
	sourceHeight?: number;
	target: string;
}

/**
 * One throttled desktop preview for the GUI picture-in-picture. Produced by a
 * dedicated preview capture session, so it never replaces the coordinate
 * frame pointer input is mapped against. Never part of the model-visible
 * output: it only travels through tool updates.
 */
export interface ComputerViewerFrame {
	/** Base64 PNG bytes (no `data:` prefix). */
	data: string;
	mimeType: "image/png";
	width: number;
	height: number;
	/** Capture target: `desktop` or a window id. */
	target: string;
	/** Capture time, epoch ms. */
	at: number;
}

/** Clone-safe error metadata returned across the worker boundary. */
export interface RunErrorPayload {
	name: string;
	message: string;
	stack?: string;
	isToolError: boolean;
	isAbort: boolean;
}

/** Events emitted by the persistent computer worker. */
export type ComputerWorkerOutbound =
	| { type: "ready" }
	| { type: "pong"; id: string }
	| { type: "result"; id: string; ok: true; payload: ComputerRunOk }
	| { type: "result"; id: string; ok: false; error: RunErrorPayload }
	| { type: "tool-call"; id: string; runId: string; name: string; args: unknown }
	| {
			type: "provider-call";
			id: string;
			/** Capability seam the call belongs to. */
			provider: "applications";
			method: "list" | "open";
			args: unknown;
	  }
	| { type: "input"; id: string; runId: string; event: ComputerInputEvent }
	| { type: "frame"; id: string; runId: string; frame: ComputerViewerFrame }
	| { type: "closed" };

/** Transport used by the worker core in Bun workers and tests. */
export interface ComputerWorkerTransport {
	send(message: ComputerWorkerOutbound, transfer?: Bun.Transferable[]): void;
	onMessage(handler: (message: ComputerWorkerInbound) => void): () => void;
	close(): void;
}
