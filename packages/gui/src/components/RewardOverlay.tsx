import { t } from "@musepi/desktop-web";
import { CountUp } from "@musepi/desktop-web/src/widgets/count-up";
import { CircleCheck, Gift, RotateCcw, Share2, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { openExternalUrl } from "../lib/electron";
import { sfxFor } from "../lib/sfx";
import { useTwoPhaseEnter } from "../lib/use-two-phase-enter";

/** Exit animation duration (mirrors gui-obo-card-out in gui-widgets.css). */
const REWARD_EXIT_MS = 200;

/** Campaign payload served by the daemon (changelog.startup → reward,
 *  read from <agentDir>/reward.json). Display strings are campaign
 *  content — they come from the payload, with i18n fallbacks below. */
export interface RewardPayload {
	id: string;
	brand?: string;
	label?: string;
	amount: number;
	amountLabel?: string;
	subtitle?: string;
	expiresLabel?: string;
	successTitle?: string;
	successDesc?: string;
	primaryLabel?: string;
	primaryUrl?: string;
	secondaryLabel?: string;
}

/**
 * Celebratory reward-ticket overlay (ZCode Weekend-Build style): starry
 * night sky, a floating 3D-tilting ticket card with a count-up amount and
 * a claim-success panel. Mounted by AnnouncementOverlay when the startup
 * payload carries a reward campaign; Escape/close handled there and here.
 *
 * Layered transforms (no conflicts): `.gui-reward-tilt` owns the pointer
 * tilt via --tilt-x/--tilt-y, `.gui-reward-float` the idle bob, and the
 * ticket itself the one-shot entrance — each element animates its own
 * transform only. All motion degrades under gui-motion-off / reduced-motion.
 */
export function RewardOverlay({ payload, onClose }: { payload: RewardPayload; onClose: () => void }): ReactNode {
	const [closing, setClosing] = useState(false);
	// Replay bumps the key → the ticket remounts and the entrance replays.
	const [runId, setRunId] = useState(0);
	const [shared, setShared] = useState(false);
	const enteredCls = useTwoPhaseEnter(true);
	const tiltRef = useRef<HTMLDivElement | null>(null);

	const requestClose = useCallback((): void => {
		setClosing(true);
		setTimeout(() => {
			setClosing(false);
			onClose();
		}, REWARD_EXIT_MS);
	}, [onClose]);

	// Claim sound on open (master sound switch respected inside sfxFor).
	useEffect(() => {
		sfxFor("complete");
	}, []);

	// Escape closes the reward — capture phase wins over the page behind.
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				requestClose();
			}
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [requestClose]);

	const onTilt = useCallback((e: React.PointerEvent): void => {
		const el = tiltRef.current;
		if (!el || document.documentElement.classList.contains("gui-motion-off")) return;
		const rect = el.getBoundingClientRect();
		const dx = (e.clientX - rect.left) / rect.width - 0.5;
		const dy = (e.clientY - rect.top) / rect.height - 0.5;
		el.style.setProperty("--tilt-x", `${(-dy * 10).toFixed(2)}deg`);
		el.style.setProperty("--tilt-y", `${(dx * 14).toFixed(2)}deg`);
	}, []);

	const resetTilt = useCallback((): void => {
		const el = tiltRef.current;
		if (!el) return;
		el.style.setProperty("--tilt-x", "0deg");
		el.style.setProperty("--tilt-y", "0deg");
	}, []);

	const onPrimary = useCallback((): void => {
		if (payload.primaryUrl) openExternalUrl(payload.primaryUrl);
		requestClose();
	}, [payload.primaryUrl, requestClose]);

	const onShare = useCallback((): void => {
		const text = [payload.brand, payload.successDesc ?? payload.subtitle].filter(Boolean).join(" — ");
		void navigator.clipboard?.writeText(text).catch(() => {});
		setShared(true);
	}, [payload.brand, payload.successDesc, payload.subtitle]);

	return (
		<div
			className={`gui-onboarding-backdrop${enteredCls ? " gui-onboarding-backdrop--entered" : ""}${closing ? " gui-onboarding-backdrop--closing" : ""}`}
		>
			<div className={`gui-reward-card${closing ? " gui-reward-card--closing" : ""}`}>
				<div className="gui-reward-sky" onPointerLeave={resetTilt} onPointerMove={onTilt}>
					<span className="gui-reward-stars" aria-hidden />
					<span className="gui-reward-shoot gui-reward-shoot--a" aria-hidden />
					<span className="gui-reward-shoot gui-reward-shoot--b" aria-hidden />
					<button
						className="gui-reward-skybtn gui-reward-skybtn--replay"
						type="button"
						title={t("reward replay")}
						onClick={() => setRunId(r => r + 1)}
					>
						<RotateCcw size={14} />
					</button>
					<button
						className="gui-reward-skybtn gui-reward-skybtn--close"
						type="button"
						title={t("close")}
						onClick={requestClose}
					>
						<X size={15} />
					</button>
					<div className="gui-reward-tilt" ref={tiltRef}>
						<div className="gui-reward-float">
							<div className="gui-reward-ticket" key={runId}>
								<div className="gui-reward-ticket-head">
									<span className="gui-reward-brand">
										<span className="gui-reward-logo">{(payload.brand ?? "M").slice(0, 1)}</span>
										{payload.brand ?? "MusePi"}
									</span>
									{payload.label && <span className="gui-reward-label">{payload.label}</span>}
								</div>
								<div className="gui-reward-amount">
									<CountUp duration={1400} value={payload.amount} format={n => n.toLocaleString("en-US")} />
									{payload.amountLabel && <span> {payload.amountLabel}</span>}
								</div>
								{payload.subtitle && (
									<div className="gui-reward-subtitle">
										<Gift size={14} />
										{payload.subtitle}
									</div>
								)}
								<div className="gui-reward-divider">
									<span className="gui-reward-notch gui-reward-notch--l" aria-hidden />
									<span className="gui-reward-notch gui-reward-notch--r" aria-hidden />
								</div>
								{payload.expiresLabel && <div className="gui-reward-expires">{payload.expiresLabel}</div>}
							</div>
						</div>
					</div>
				</div>
				<div className="gui-reward-panel">
					<div className="gui-reward-success">
						<CircleCheck className="gui-reward-check" size={22} />
						<div className="min-w-0">
							<div className="gui-reward-success-title">{payload.successTitle ?? t("reward claim success")}</div>
							<div className="gui-reward-success-desc">{payload.successDesc ?? t("reward ready desc")}</div>
						</div>
					</div>
					<button className="gui-reward-primary" type="button" onClick={onPrimary}>
						{payload.primaryLabel ?? t("reward start")}
					</button>
					<button className="gui-reward-secondary" type="button" onClick={onShare}>
						<Share2 size={14} />
						{shared ? t("copied") : (payload.secondaryLabel ?? t("reward share"))}
					</button>
				</div>
			</div>
		</div>
	);
}
