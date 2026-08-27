import { type } from "@musepi/musepi-type";
import type { AgentToolContext } from "@musepi/pi-agent-core";
import { prompt } from "@musepi/pi-utils";
import type { CustomTool } from "../extensibility/custom-tools/types";

/**
 * Collab share tool — lets the agent start/stop remote sharing of the
 * current session or workspace, mirroring the daemon's `collab.*` RPC
 * surface (GUI share panel, TUI /collab).
 *
 * Security model:
 * - LAN share (`mode: "lan"`, default) exposes a relay on the local network
 *   only; approval tier `write` (auto-approved in write mode).
 * - Public tunnel (`mode: "tunnel"`) exposes a public URL through
 *   cloudflared/ngrok — anyone with the link can join. Approval tier `exec`
 *   with `override: true`, so it prompts even in modes that would normally
 *   auto-approve `exec` (yolo still bypasses by design).
 *
 * The handle (`ctx.collab`) is injected by the daemon; standalone TUI/CLI
 * sessions have no daemon to share through and report that instead.
 */
const collabSchema = type({
	action: type
		.enumerated("start", "stop", "status")
		.describe(
			"start begins sharing, stop closes an active share, status reports whether sharing is active and returns the link if so",
		),
	"mode?": type
		.enumerated("lan", "tunnel", "workspace")
		.describe(
			'Share transport and scope for action="start": "lan" shares on the local network (default), "tunnel" opens a public URL via cloudflared/ngrok, "workspace" shares the whole workspace instead of the current session',
		),
	"sessionId?": type("string").describe(
		'Session to share; defaults to the current session. Ignored when mode is "workspace"',
	),
});

interface CollabToolDetails {
	readonly action: "start" | "stop" | "status";
	readonly mode?: string;
}

/** Shape of the daemon-injected collab handle on AgentToolContext. */
export interface CollabToolHandle {
	start(opts: { mode?: "lan" | "tunnel" | "workspace"; sessionId?: string }): Promise<{
		link?: string;
		webLink?: string;
		viewLink?: string;
	}>;
	stop(): Promise<{ ok: boolean }>;
	status(): Promise<{
		hosting: boolean;
		link?: string;
		webLink?: string;
		viewLink?: string;
	}>;
	generatePair(): Promise<{ code: string; expiresInSeconds: number; lanPort: number }>;
}

export const collabTool: CustomTool<typeof collabSchema, CollabToolDetails> = {
	name: "collab",
	label: "CollabShare",
	strict: false,
	approval: (args: unknown) => {
		const a = (args ?? {}) as { action?: string; mode?: string };
		if (a.action === "start" && a.mode === "tunnel") {
			return {
				tier: "exec",
				override: true,
				reason:
					"Opens a PUBLIC tunnel — anyone with the link can join this agent session. Only continue if remote access is intended.",
			};
		}
		if (a.action === "start")
			return { tier: "write", reason: "Starts a remote share of this session on the local network." };
		if (a.action === "stop") return { tier: "write", reason: "Closes the active remote share." };
		return { tier: "read" };
	},
	formatApprovalDetails: (args: unknown) => {
		const a = (args ?? {}) as { action?: string; mode?: string; sessionId?: string };
		const lines = [`Action: ${a.action ?? "start"}`];
		if (a.mode) lines.push(`Mode: ${a.mode}`);
		if (a.sessionId) lines.push(`Session: ${a.sessionId}`);
		return lines;
	},
	description: prompt.render(
		'Start, stop, or check remote sharing of the current session or workspace. When sharing is active, the host\'s phone (MusePi Mobile) or any browser can join to watch and send messages. Use `collab` with `action: "start"` when the user asks to enable remote/mobile access; report the returned link (and 6-digit pair code on LAN) to the user. Prefer `mode: "lan"` unless the user is away from the local network — `mode: "tunnel"` exposes a public URL and requires explicit approval.',
	),
	parameters: collabSchema,
	async execute(_toolCallId, params, _onUpdate, ctx) {
		// The daemon injects the collab handle on AgentToolContext (declaration
		// merging in tools/context.ts); the CustomTool execute signature only
		// sees CustomToolContext, so narrow through the extended interface.
		const collab = (ctx as AgentToolContext).collab;
		if (!collab) {
			return {
				content: [
					{
						type: "text",
						text: "Remote sharing is unavailable in this environment (no daemon). Use `/collab` in the TUI or the share panel in the desktop GUI instead.",
					},
				],
				details: { action: params.action, mode: params.mode },
				isError: true,
			};
		}
		const action = params.action;
		if (action === "status") {
			const st = await collab.status();
			if (!st.hosting) {
				return {
					content: [{ type: "text", text: "No active share." }],
					details: { action, mode: params.mode },
				};
			}
			const lines = ["Share is active:"];
			if (st.webLink) lines.push(`- Web link: ${st.webLink}`);
			if (st.link) lines.push(`- Collab link: ${st.link}`);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { action, mode: params.mode },
			};
		}
		if (action === "stop") {
			await collab.stop();
			return {
				content: [{ type: "text", text: "Share stopped." }],
				details: { action, mode: params.mode },
			};
		}
		// action === "start"
		const mode = params.mode ?? "lan";
		const sessionId =
			mode === "workspace" ? undefined : (params.sessionId ?? (ctx.sessionManager.getSessionId() || undefined));
		const res = await collab.start({ mode, sessionId });
		if (!res.webLink && !res.link) {
			return {
				content: [{ type: "text", text: "Sharing started but no link was produced." }],
				details: { action, mode },
				isError: true,
			};
		}
		// LAN share: also mint a 6-digit pair code for the no-camera path.
		let pairLine = "";
		if (mode === "lan" || mode === "workspace") {
			const pair = await collab.generatePair().catch(() => null);
			if (pair) pairLine = `\n- 6-digit pair code: ${pair.code} (same network as the host)`;
		}
		const link = res.webLink ?? res.link!;
		const warning =
			mode === "tunnel"
				? '\n\n⚠️ PUBLIC tunnel: anyone with this link can join. Stop the share (collab action:"stop") when done.'
				: "\n\nGuests on the same network can join by scanning the QR or opening the link; the 6-digit code works in the MusePi Mobile app.";
		return {
			content: [
				{
					type: "text",
					text: `Remote sharing started (mode: ${mode}).\n- Link: ${link}${pairLine}${warning}`,
				},
			],
			details: { action, mode },
		};
	},
};
