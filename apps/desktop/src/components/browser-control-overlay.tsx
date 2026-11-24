import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { tabAgent } from "../lib/managed-browser-host";
import { Icon } from "../vendor/oc-icons";

export interface BrowserControlActivity {
	id: string;
	action: string;
	summary: string;
	domain: string | null;
	status: string;
	tabId: string;
	at: number;
	/** Operator announced with the activity, when the host knows it. */
	agentId?: string | null;
	agentName?: string | null;
}

const EXIT_MS = 180;

/** How long a refused page interaction keeps the capsule in its denial state.
 *  Long enough to read, short enough that the next attempt reads as new. */
const DENY_MS = 1_400;

export function BrowserControlOverlay({
	activity,
	onTakeover,
	onHandBack,
	userOwned = false,
	userOwnedTitle,
	onReveal,
	now,
	frameRect,
	inView = true,
	since,
	visible,
}: {
	activity: BrowserControlActivity | null;
	/** Hand the tab to the user. The host receives which tab, so plugins can
	 *  react without re-deriving it from the activity ledger. */
	onTakeover(info: { tabId: string; url: string; title: string }): void | Promise<void>;
	/** Give the tab back to the agent after a takeover. */
	onHandBack?(): void | Promise<void>;
	/** The user holds this tab: show a persistent takeover pill instead of the
	 *  agent capsule, so the handoff stays visible and reversible. */
	userOwned?: boolean;
	userOwnedTitle?: string;
	onReveal?(): void;
	now?: number;
	frameRect?: { x: number; y: number; width: number; height: number };
	inView?: boolean;
	/** Start of the agent's hold on this tab; keeps the counter continuous
	 *  across steps instead of restarting on every operation. */
	since?: number;
	/** Whether the agent still holds the tab. Defaults to "the operation is
	 *  running", which makes the card vanish between tool calls. */
	visible?: boolean;
}): ReactNode {
	const active = visible ?? activity?.status === "dispatched";
	const [displayActivity, setDisplayActivity] = useState(activity);
	const [closing, setClosing] = useState(false);
	const [pending, setPending] = useState(false);
	const [clock, setClock] = useState(now ?? Date.now());
	// The page is not the user's to operate while the agent drives it: the
	// blocker swallows the interaction and the capsule answers, so a click is
	// refused visibly instead of being acted on behind the agent's back.
	// `denyAt` re-arms the timer, so a burst of clicks keeps the refusal up
	// instead of expiring 1.4s after the first one.
	const [denied, setDenied] = useState(false);
	const [denyAt, setDenyAt] = useState(0);

	useEffect(() => {
		if (active) {
			setDisplayActivity(activity);
			setClosing(false);
			return;
		}
		if (!displayActivity) return;
		setClosing(true);
		const timer = window.setTimeout(() => {
			setDisplayActivity(null);
			setClosing(false);
		}, EXIT_MS);
		return () => window.clearTimeout(timer);
	}, [active, activity, displayActivity]);

	useEffect(() => {
		if (!active) return;
		setClock(now ?? Date.now());
		if (now !== undefined) return;
		const timer = window.setInterval(() => setClock(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [active, now]);

	// A refusal is a transient reading of the same capsule, not a second state
	// machine: the denial styling clears itself so the next attempt reads new.
	useEffect(() => {
		if (!denied) return;
		const timer = window.setTimeout(() => setDenied(false), DENY_MS);
		return () => window.clearTimeout(timer);
	}, [denied, denyAt]);

	// The agent holds this tab: nothing on the page is the user's to operate —
	// not even while a takeover request is still in flight. A background tab
	// (out of view) is the user's own page, so it stays live.
	const blocked = active && inView;
	useEffect(() => {
		if (!blocked) setDenied(false);
	}, [blocked]);
	const refuse = (event: { preventDefault(): void; stopPropagation(): void }): void => {
		event.preventDefault();
		event.stopPropagation();
		setDenied(true);
		setDenyAt(Date.now());
	};

	// User-owned: the agent no longer controls this tab. Keep the handoff
	// visible and give it back explicitly; nothing resumes on its own.
	if (userOwned && !(displayActivity && active)) {
		return typeof document === "undefined"
			? null
			: createPortal(
					<div
						className="gui-browser-control-frame"
						data-browser-control="user"
						style={{
							position: "fixed",
							left: frameRect?.x ?? 5,
							top: frameRect?.y ?? 5,
							width: frameRect?.width ?? "calc(100% - 10px)",
							height: frameRect?.height ?? "calc(100% - 10px)",
							zIndex: 1000,
						}}
					>
						<div className="gui-browser-control-card gui-liquid-glass">
							<span className="gui-browser-control-leading" aria-hidden>
								<Icon name="user" className="h-4 w-4" />
							</span>
							<span className="gui-browser-control-copy">
								<span className="gui-browser-control-title" role="status" aria-live="polite">
									{t("tools.userOwnedTab")}
								</span>
								<span className="gui-browser-control-summary">
									{userOwnedTitle ?? t("tools.userOwnedHint")}
								</span>
							</span>
							<button
								type="button"
								className="gui-browser-control-takeover"
								aria-label={t("tools.browserHandBack")}
								title={t("tools.browserHandBackHint")}
								disabled={pending}
								onClick={() => void handBack()}
							>
								<Icon name="robot" className="h-3.5 w-3.5" />
								<span>{t("tools.browserHandBack")}</span>
							</button>
						</div>
					</div>,
					document.body,
				);
	}
	if (!displayActivity) return null;
	const startedAt = since ?? displayActivity.at;
	const elapsed = Math.max(0, Math.floor((clock - startedAt) / 1000));
	const minutes = Math.floor(elapsed / 60);
	const seconds = elapsed % 60;
	const time = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
	const state = closing ? "closing" : inView ? "running" : "out-of-view";
	// The activity ledger names the tab, not the agent. A subagent's browser
	// tab carries its operator, so resolve the name from the tab when the
	// activity itself does not carry one.
	const agentName = displayActivity.agentName ?? tabAgent(displayActivity.tabId)?.name ?? null;
	const takeover = async (): Promise<void> => {
		if (pending) return;
		setPending(true);
		try {
			await onTakeover({
				tabId: displayActivity.tabId,
				url: displayActivity.domain ?? "",
				title: displayActivity.summary,
			});
		} catch {
			// Keep the current operation visible so the user can retry.
		} finally {
			setPending(false);
		}
	};
	const handBack = async (): Promise<void> => {
		if (pending) return;
		setPending(true);
		try {
			await onHandBack?.();
		} finally {
			setPending(false);
		}
	};
	const overlay = (
		<div
			className={`gui-browser-control-frame${inView ? "" : " gui-browser-control-frame--out-of-view"}`}
			data-browser-control={state}
			data-blocked={denied ? "true" : undefined}
			style={{
				position: "fixed",
				left: frameRect?.x ?? 5,
				top: frameRect?.y ?? 5,
				width: frameRect?.width ?? "calc(100% - 10px)",
				height: frameRect?.height ?? "calc(100% - 10px)",
				zIndex: 1000,
			}}
		>
			{blocked && (
				// The page is the agent's while it drives this tab. This layer is
				// the only pointer target inside the ring, so clicks, context
				// menus and drags stop here instead of acting behind the agent's
				// back. It takes no tab stop and blocks no wheel: reading the page
				// is passive, and the takeover button is already reachable by
				// keyboard. Typing keeps going wherever it went before — on the
				// guest that is the main process's own handoff.
				<div
					className="gui-browser-control-blocker"
					data-browser-control-blocker=""
					aria-hidden="true"
					onPointerDown={refuse}
					onClick={refuse}
					onDoubleClick={refuse}
					onContextMenu={refuse}
					onDragStart={refuse}
				/>
			)}
			<div className="gui-browser-control-card gui-liquid-glass">
				<span className="gui-browser-control-leading" aria-hidden>
					<Icon name="robot" className="h-4 w-4" />
				</span>
				<span className="gui-browser-control-copy">
					<span className="gui-browser-control-title" role="status" aria-live="polite">
						{pending
							? t("tools.controlPaused")
							: !inView
								? t("tools.controlOutOfView")
								: displayActivity.status === "dispatched"
									? t("tools.agentOperating")
									: t("tools.agentHolding")}
						{agentName && (
							<span
								data-browser-agent={agentName}
								title={agentName}
								style={{ marginLeft: 6, fontWeight: 500, color: "var(--color-text-muted)" }}
							>
								{t("tools.browserAgentOperator", { agent: agentName })}
							</span>
						)}
					</span>
					<span className="gui-browser-control-summary" title={displayActivity.summary}>
						{denied ? (
							t("tools.browserBlockedHint")
						) : (
							<>
								{displayActivity.domain ? `${displayActivity.domain} · ` : ""}
								{displayActivity.summary}
							</>
						)}
					</span>
				</span>
				<span className="gui-browser-control-time" data-elapsed={elapsed} aria-hidden="true">
					{t("tools.agentControlElapsed", { time })}
				</span>
				{!inView && onReveal && (
					<button
						type="button"
						className="gui-browser-control-reveal"
						aria-label={t("tools.browserShowAgentTab")}
						title={t("tools.browserShowAgentTab")}
						onClick={onReveal}
					>
						<Icon name="arrow-right-s" className="h-3.5 w-3.5" />
						<span>{t("tools.browserShowAgentTab")}</span>
					</button>
				)}
				<button
					type="button"
					className="gui-browser-control-takeover"
					aria-label={t("tools.browserTakeover")}
					title={t("tools.browserTakeoverHint")}
					disabled={pending}
					onClick={() => void takeover()}
				>
					<Icon name="user" className="h-3.5 w-3.5" />
					<span>{pending ? t("tools.browserTakeoverPending") : t("tools.browserTakeover")}</span>
				</button>
			</div>
		</div>
	);
	return typeof document === "undefined" ? overlay : createPortal(overlay, document.body);
}
