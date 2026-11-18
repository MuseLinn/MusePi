import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { type TranslationKey, t } from "../../i18n/index.js";
import type { SessionClient } from "../../lib/client";
import { useGuestSelector } from "../../lib/use-guest";

/**
 * Picture-in-picture desktop preview while the computer tool runs.
 *
 * Frames arrive on the tool-update bypass (`details.viewer`) and never enter
 * the model-visible output, so this card is purely a user-facing readout: it
 * shows the desktop the agent is operating plus the latest input action. It
 * rises on its own when a run starts, collapses to a static thumbnail when the
 * run ends, and keeps exactly one frame — a newer frame replaces the previous
 * one, and a session switch drops it.
 */

/** The part of a tool-call record the preview reads. */
export interface ViewerToolState {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly partialResult?: unknown;
}

/** Everything the preview needs, independent of the transport behind it. */
export interface ComputerViewerPipSource {
	readonly activeTools: ReadonlyMap<string, ViewerToolState>;
	/** Drops the retained frame when this changes (session switch). */
	readonly sessionKey: string | null;
	/** True while an approval waits — the preview steps aside. */
	readonly blocked: boolean;
}

interface ViewerFrame {
	data: string;
	mimeType: string;
	width: number;
	height: number;
	target: string;
	at: number;
}

interface ViewerAction {
	kind: string;
	app?: string;
	title?: string;
}

const ACTION_KEYS = {
	click: "tools.computerAction.click",
	doubleClick: "tools.computerAction.doubleClick",
	move: "tools.computerAction.move",
	drag: "tools.computerAction.drag",
	scroll: "tools.computerAction.scroll",
	type: "tools.computerAction.type",
	press: "tools.computerAction.press",
	raise: "tools.computerAction.raise",
	setValue: "tools.computerAction.setValue",
	perform: "tools.computerAction.perform",
	focus: "tools.computerAction.focus",
} as const satisfies Record<string, TranslationKey>;

function isFrame(value: unknown): value is ViewerFrame {
	if (!value || typeof value !== "object") return false;
	const frame = value as Partial<ViewerFrame>;
	return (
		typeof frame.data === "string" &&
		frame.data.length > 0 &&
		typeof frame.mimeType === "string" &&
		typeof frame.width === "number" &&
		typeof frame.height === "number" &&
		typeof frame.target === "string"
	);
}

function isAction(value: unknown): value is ViewerAction {
	if (!value || typeof value !== "object") return false;
	return typeof (value as { kind?: unknown }).kind === "string";
}

/** Reads the viewer frame and latest action out of one partial tool result. */
function readViewer(result: unknown): { frame?: ViewerFrame; action?: ViewerAction } {
	if (!result || typeof result !== "object") return {};
	const details = (result as { details?: unknown }).details;
	if (!details || typeof details !== "object") return {};
	const out: { frame?: ViewerFrame; action?: ViewerAction } = {};
	const frame = (details as { viewer?: unknown }).viewer;
	if (isFrame(frame)) out.frame = frame;
	const events = (details as { inputEvents?: unknown }).inputEvents;
	if (Array.isArray(events)) {
		const last = events[events.length - 1];
		if (isAction(last)) out.action = last;
	}
	return out;
}

function actionText(action: ViewerAction | undefined): string | null {
	if (!action) return null;
	const key = ACTION_KEYS[action.kind as keyof typeof ACTION_KEYS];
	const label = key ? t(key) : action.kind;
	const target = action.title ?? action.app;
	return target ? `${label} · ${target}` : label;
}

export function ComputerViewerPipView({ activeTools, sessionKey, blocked }: ComputerViewerPipSource): ReactNode {
	const active = useMemo(() => {
		for (const tool of activeTools.values()) if (tool.toolName === "computer") return tool;
		return undefined;
	}, [activeTools]);
	const live = useMemo(() => (active ? readViewer(active.partialResult) : {}), [active]);

	// One retained frame/action outlives the run so the card can fall back to a
	// static thumbnail; a newer frame always replaces it.
	const [shown, setShown] = useState<{ frame?: ViewerFrame; action?: ViewerAction; runId: string | null }>({
		runId: null,
	});
	const [expanded, setExpanded] = useState(true);
	const [dismissed, setDismissed] = useState(false);
	const runId = active?.toolCallId ?? null;
	const previousSessionId = useRef(sessionKey);

	useEffect(() => {
		setShown(previous => {
			// A finished run keeps its last frame as the static thumbnail.
			if (runId === null) return previous;
			// A new run starts from its own frames; nothing from the last one
			// survives into the live card.
			if (runId !== previous.runId) return { runId, frame: live.frame, action: live.action };
			return { runId, frame: live.frame ?? previous.frame, action: live.action ?? previous.action };
		});
	}, [runId, live]);

	useEffect(() => {
		// A new run auto-raises the card and clears an earlier dismissal; a
		// finished run collapses to the thumbnail. A manual collapse during the
		// run is not overridden — nothing changes until the next run boundary.
		if (runId !== null) {
			setExpanded(true);
			setDismissed(false);
		} else {
			setExpanded(false);
		}
	}, [runId]);

	useEffect(() => {
		if (previousSessionId.current === sessionKey) return;
		previousSessionId.current = sessionKey;
		setShown({ runId: null });
		setExpanded(true);
		setDismissed(false);
	}, [sessionKey]);

	// A live card shows only this run's frames; the retained frame appears
	// once the run has ended.
	const frame = live.frame ?? (runId === null ? shown.frame : undefined);
	const action = actionText(live.action ?? (runId === null ? shown.action : undefined));
	const running = active !== undefined;
	// A pending approval owns the lower part of the transcript; the preview
	// must not cover the decision the user has to make.
	if (!frame || dismissed || blocked) return null;

	const title = running ? t("tools.computerViewerLive") : t("tools.computerViewerRecent");
	const alt = action ? t("tools.computerViewerLastAction", { action }) : t("tools.computerViewerNoAction");
	const source = `data:${frame.mimeType};base64,${frame.data}`;

	return (
		<div className="cvp" data-running={running ? "true" : "false"} data-expanded={expanded ? "true" : "false"}>
			{expanded ? (
				<figure className="cvp-card">
					<header className="cvp-head">
						<span className="cvp-dot" aria-hidden="true" />
						<span className="cvp-title">{title}</span>
						<button
							type="button"
							className="cvp-icon"
							aria-label={t("tools.computerViewerCollapse")}
							onClick={() => setExpanded(false)}
						>
							<span aria-hidden="true">−</span>
						</button>
						<button
							type="button"
							className="cvp-icon"
							aria-label={t("tools.computerViewerDismiss")}
							onClick={() => setDismissed(true)}
						>
							<span aria-hidden="true">×</span>
						</button>
					</header>
					<img className="cvp-frame" src={source} alt={alt} draggable={false} />
					<figcaption className="cvp-caption" title={alt}>
						{action ?? t("tools.computerViewerNoAction")}
					</figcaption>
				</figure>
			) : (
				<div className="cvp-thumb">
					<button
						type="button"
						className="cvp-thumb-main"
						aria-label={t("tools.computerViewerExpand")}
						onClick={() => setExpanded(true)}
					>
						<img className="cvp-thumb-frame" src={source} alt="" draggable={false} />
						<span className="cvp-thumb-caption">{action ?? title}</span>
					</button>
					<button
						type="button"
						className="cvp-thumb-close"
						aria-label={t("tools.computerViewerDismiss")}
						onClick={() => setDismissed(true)}
					>
						<span aria-hidden="true">×</span>
					</button>
				</div>
			)}
		</div>
	);
}

/** Guest-shell binding: subscribes to one session client and renders the preview. */
export function ComputerViewerPip({ client }: { client: SessionClient }): ReactNode {
	const activeTools = useGuestSelector(client, s => s.activeTools);
	const sessionKey = useGuestSelector(client, s => s.focusedSessionId);
	const approval = useGuestSelector(client, s => s.approvalRequest);
	return <ComputerViewerPipView activeTools={activeTools} sessionKey={sessionKey} blocked={approval !== null} />;
}
