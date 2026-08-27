/**
 * `vibe_*` — vibe-mode agent operations (TUI createVibeToolRenderer parity):
 * spawn/send render a composer-style card with the prompt and a live status
 * line; wait shows settled/cancelled rows; kill/list show a status line.
 * The status icon morphs (morphicons) between pending and settled states.
 */

import { Check as CheckIconData, LoaderCircle as LoaderCircleIconData } from "lucide";
import { MorphIcon } from "morphicons/react";
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { Badge, Badges, Note, Output } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, str } from "../util";

type VibeOp = "spawn" | "send" | "wait" | "kill" | "list";

interface VibeSettled {
	id?: string;
	jobId?: string;
	status?: string;
}

function opOf(args: Record<string, unknown>, result: ToolRenderProps["result"]): VibeOp {
	const details = detailsRecord(result);
	const dOp = str(details?.op);
	const op = dOp || (typeof args.op === "string" ? args.op : "");
	return (["spawn", "send", "wait", "kill", "list"] as const).includes(op as VibeOp) ? (op as VibeOp) : "list";
}

function describe(args: Record<string, unknown>, result: ToolRenderProps["result"]): string {
	const op = opOf(args, result);
	switch (op) {
		case "spawn":
			return `spawn ${str(args?.cli) ?? "?"}${args?.name ? ` · ${str(args.name)}` : ""}`;
		case "send":
			return `send → ${args?.session ? str(args.session) : "?"}`;
		case "wait":
			return Array.isArray(args?.sessions) && (args.sessions as unknown[]).length > 0
				? `wait on ${(args.sessions as string[]).join(", ")}`
				: "wait on running sessions";
		case "kill":
			return `kill ${Array.isArray(args?.ids) ? (args.ids as string[]).join(", ") : "?"}`;
		default:
			return "list";
	}
}

/** Pending? (no settled details yet / wait still blocking). */
function isPending(args: Record<string, unknown>, result: ToolRenderProps["result"]): boolean {
	const details = detailsRecord(result);
	if (!details || result?.isError) return false;
	const op = opOf(args, result);
	if (op === "wait") {
		const wait = details.wait;
		return isRecord(wait) ? wait.waiting === true : false;
	}
	if (op === "spawn") return !isRecord(details.spawned);
	if (op === "send") return !isRecord(details.send);
	return false;
}

function StatusIcon({ pending }: { pending: boolean }): ReactNode {
	return (
		<span className="tv-vibe-icon" aria-hidden="true">
			<MorphIcon icon={pending ? LoaderCircleIconData : CheckIconData} size={13} spring="snappy" />
		</span>
	);
}

function Summary(props: ToolRenderProps): ReactNode {
	const details = detailsRecord(props.result);
	const pending = isPending(props.args, props.result);
	const status = pending ? t("vibe pending") : t("vibe settled");
	const extra: string[] = [];
	const wait = details?.wait;
	if (isRecord(wait)) {
		if (Array.isArray(wait.settled) && (wait.settled as VibeSettled[]).length > 0)
			extra.push(t("vibe settled {count}", { count: String((wait.settled as VibeSettled[]).length) }));
		if (Array.isArray(wait.stillRunning) && (wait.stillRunning as string[]).length > 0)
			extra.push(t("vibe running {count}", { count: String((wait.stillRunning as string[]).length) }));
		if (wait.timedOut === true) extra.push(t("vibe timed out"));
	}
	return (
		<>
			<div className="tv-kv-line">
				<StatusIcon pending={pending} />
				<span>vibe {describe(props.args, props.result)}</span>
				<Badge>{status}</Badge>
				{extra.length > 0 && <Badges items={extra} />}
			</div>
		</>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const op = opOf(args, result);
	const pending = isPending(args, result);
	const text = Array.isArray(result?.content)
		? ((result.content as Array<{ type?: string; text?: string }>).find(p => p.type === "text")?.text ?? "")
		: "";

	if (op === "spawn" || op === "send") {
		const message = op === "spawn" ? str(args?.prompt) : str(args?.message);
		return (
			<div className="tv-vibe-composer">
				{message && <div className="tv-vibe-message">{message}</div>}
				<div className="tv-kv-line">
					<StatusIcon pending={pending} />
					<span className="tv-vibe-status">
						{pending
							? op === "spawn"
								? t("vibe booting")
								: t("vibe delivering")
							: op === "spawn"
								? t("vibe spawned")
								: t("vibe sent")}
					</span>
				</div>
			</div>
		);
	}

	if (op === "wait" && isRecord(details?.wait)) {
		const wait = details.wait as {
			settled?: VibeSettled[];
			stillRunning?: string[];
			timedOut?: boolean;
		};
		return (
			<>
				{Array.isArray(wait.settled) &&
					wait.settled.map((s, i) => (
						<div key={i} className="tv-kv-line">
							<Badge tone={s.status === "failed" ? "err" : s.status === "cancelled" ? "warn" : "ok"}>
								{s.status ?? "?"}
							</Badge>
							<span>{str(s.id)}</span>
						</div>
					))}
				{Array.isArray(wait.stillRunning) && wait.stillRunning.length > 0 && (
					<Note tone="warn">{t("vibe still running {list}", { list: wait.stillRunning.join(", ") })}</Note>
				)}
				{wait.timedOut === true && <Note tone="warn">{t("vibe timed out")}</Note>}
			</>
		);
	}

	if (text) {
		return <Output text={text} maxLines={10} error={result?.isError === true} />;
	}
	return null;
}

export const vibeRenderer: ToolRenderer = {
	Summary,
	Body,
};
