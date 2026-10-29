import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../vendor/oc-icons";

export interface BrowserControlActivity {
	id: string;
	action: string;
	summary: string;
	domain: string | null;
	status: string;
	tabId: string;
	at: number;
}

const EXIT_MS = 180;

export function BrowserControlOverlay({
	activity,
	onTakeover,
	onReveal,
	now,
	frameRect,
	inView = true,
}: {
	activity: BrowserControlActivity | null;
	onTakeover(): void | Promise<void>;
	onReveal?(): void;
	now?: number;
	frameRect?: { x: number; y: number; width: number; height: number };
	inView?: boolean;
}): ReactNode {
	const active = activity?.status === "dispatched";
	const [displayActivity, setDisplayActivity] = useState(activity);
	const [closing, setClosing] = useState(false);
	const [pending, setPending] = useState(false);
	const [clock, setClock] = useState(now ?? Date.now());

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

	if (!displayActivity) return null;
	const elapsed = Math.max(0, Math.floor((clock - displayActivity.at) / 1000));
	const minutes = Math.floor(elapsed / 60);
	const seconds = elapsed % 60;
	const time = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
	const state = closing ? "closing" : inView ? "running" : "out-of-view";
	const takeover = async (): Promise<void> => {
		if (pending) return;
		setPending(true);
		try {
			await onTakeover();
		} catch {
			// Keep the current operation visible so the user can retry.
		} finally {
			setPending(false);
		}
	};
	const overlay = (
		<div
			className={`gui-browser-control-frame${inView ? "" : " gui-browser-control-frame--out-of-view"}`}
			data-browser-control={state}
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
					<Icon name="robot" className="h-4 w-4" />
				</span>
				<span className="gui-browser-control-copy">
					<span className="gui-browser-control-title" role="status" aria-live="polite">
						{pending
							? t("tools.controlPaused")
							: inView
								? t("tools.agentOperating")
								: t("tools.controlOutOfView")}
					</span>
					<span className="gui-browser-control-summary">{displayActivity.summary}</span>
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
