/**
 * First-launch onboarding overlay (settings footer 引导 entry + auto-open
 * on first run). ZCode-style two-pane primer: the left pane holds step
 * content with a morphing icon (MorphIcon spring between step icons); the
 * right pane is an animated, purely-visual mini-demo of each feature
 * (CSS keyframes, replays on step switch). Completing it stores
 * omp-gui-onboarding-done so it never auto-opens again; the settings
 * footer button reopens it on demand.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { MessagesSquare, Settings2, SquareTerminal } from "lucide";
import { MorphIcon } from "morphicons/react";
import { t } from "@musepi/collab-web";
import { Icon } from "../vendor/oc-icons";
import { tapFeedback } from "../lib/haptic";
import { DONE_KEY, onboardingPending } from "../lib/onboarding";

const STEPS = [
	{ icon: MessagesSquare, key: "onboarding step1" },
	{ icon: SquareTerminal, key: "onboarding step2" },
	{ icon: Settings2, key: "onboarding step3" },
] as const;

/** Animated feature previews — pure CSS loops, no live data. */
function StepDemo({ step }: { step: number }): ReactNode {
	if (step === 0) {
		return (
			<div className="gui-obo-window">
				<div className="gui-obo-sidebar">
					<div className="gui-obo-sidebar-item" />
					<div className="gui-obo-sidebar-item gui-obo-sidebar-item--active" />
					<div className="gui-obo-sidebar-item" />
				</div>
				<div className="gui-obo-main">
					<div className="gui-obo-main-bar" />
					<div className="gui-obo-main-lines" />
				</div>
			</div>
		);
	}
	if (step === 1) {
		return (
			<div className="gui-obo-chat">
				<div className="gui-obo-bubble gui-obo-bubble--user" />
				<div className="gui-obo-bubble gui-obo-bubble--assistant" />
				<div className="gui-obo-typing">
					<span />
					<span />
					<span />
				</div>
			</div>
		);
	}
	return (
		<div className="gui-obo-settings">
			<div className="gui-obo-setting-row">
				<div className="gui-obo-setting-label" />
				<div className="gui-obo-toggle gui-obo-toggle--on" />
			</div>
			<div className="gui-obo-setting-row">
				<div className="gui-obo-setting-label" />
				<div className="gui-obo-toggle" />
			</div>
			<div className="gui-obo-setting-row gui-obo-setting-row--open">
				<div className="gui-obo-setting-label" />
				<div className="gui-obo-setting-expand" />
			</div>
		</div>
	);
}

export function OnboardingOverlay(): ReactNode {
	const [open, setOpen] = useState(onboardingPending);
	const [step, setStep] = useState(0);

	// Settings footer 引导 button reopens the primer on demand.
	useEffect(() => {
		const onOpen = (): void => {
			setStep(0);
			setOpen(true);
		};
		window.addEventListener("omp-open-onboarding", onOpen);
		return () => window.removeEventListener("omp-open-onboarding", onOpen);
	}, []);

	const finish = useCallback((): void => {
		try {
			localStorage.setItem(DONE_KEY, "1");
		} catch {
			// ignore
		}
		setOpen(false);
	}, []);

	if (!open) return null;
	const current = STEPS[step];
	const last = step === STEPS.length - 1;
	return (
		<div className="gui-onboarding-backdrop">
			<div className="gui-onboarding-card">
				<div className="gui-onboarding-topbar">
					<span className="gui-onboarding-badge">{t("onboarding badge")}</span>
					<button
						type="button"
						className="gui-onboarding-close"
						aria-label={t("close")}
						onClick={() => {
							tapFeedback();
							finish();
						}}
					>
						<Icon name="close" className="h-4 w-4" />
					</button>
				</div>
				<div className="gui-onboarding-grid">
					<div className="gui-onboarding-pane" key={step}>
						<div className="gui-onboarding-icon">
							<MorphIcon icon={current.icon} size={30} spring="snappy" />
						</div>
						<div className="gui-onboarding-title">{t("onboarding title")}</div>
						<div className="gui-onboarding-body">{t(current.key)}</div>
						<div className="gui-onboarding-dots">
							{STEPS.map((s, i) => (
								<span
									key={s.key}
									className={`gui-onboarding-dot${i === step ? " gui-onboarding-dot--active" : ""}`}
								/>
							))}
						</div>
						<div className="gui-onboarding-actions">
							{step > 0 && (
								<button
									type="button"
									className="gui-btn gui-btn-ghost"
									onClick={() => {
										tapFeedback();
										setStep(s => s - 1);
									}}
								>
									{t("back")}
								</button>
							)}
							<button
								type="button"
								className="gui-btn gui-btn-primary gui-onboarding-next"
								onClick={() => {
									tapFeedback();
									if (!last) setStep(s => s + 1);
									else finish();
								}}
							>
								<span>{last ? t("get started") : t("next")}</span>
								<Icon name="arrow-right" className="h-4 w-4" />
							</button>
						</div>
					</div>
					<div className="gui-onboarding-visual">
						<StepDemo step={step} />
					</div>
				</div>
			</div>
		</div>
	);
}
