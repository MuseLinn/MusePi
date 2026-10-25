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

export function BrowserControlOverlay({
	activity,
	onTakeover,
	now,
	frameRect,
}: {
	activity: BrowserControlActivity | null;
	onTakeover(): void;
	now?: number;
	frameRect?: { x: number; y: number; width: number; height: number };
}): ReactNode {
	const active = activity?.status === "dispatched";
	const [clock, setClock] = useState(now ?? Date.now());
	useEffect(() => {
		if (!active) return;
		setClock(now ?? Date.now());
		if (now !== undefined) return;
		const timer = window.setInterval(() => setClock(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [active, now]);
	if (!active || !activity) return null;
	const elapsed = Math.max(0, Math.floor((clock - activity.at) / 1000));
	const minutes = Math.floor(elapsed / 60);
	const seconds = elapsed % 60;
	const time = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
	const overlay = (
		<div
			className="gui-browser-control-frame"
			data-browser-control="running"
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
						{t("tools.agentOperating")}
					</span>
					<span className="gui-browser-control-summary">{activity.summary}</span>
				</span>
				<span className="gui-browser-control-time" data-elapsed={elapsed} aria-hidden="true">
					{t("tools.agentControlElapsed", { time })}
				</span>
				<button
					type="button"
					className="gui-browser-control-takeover"
					aria-label={t("tools.browserTakeover")}
					title={t("tools.browserTakeoverHint")}
					onClick={onTakeover}
				>
					<Icon name="user" className="h-3.5 w-3.5" />
					<span>{t("tools.browserTakeover")}</span>
				</button>
			</div>
		</div>
	);
	return typeof document === "undefined" ? overlay : createPortal(overlay, document.body);
}
