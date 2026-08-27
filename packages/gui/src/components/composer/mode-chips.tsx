import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { Icon } from "../../vendor/oc-icons";

/** Goal-mode chip (openchamber parity): armed state (one tap with no live
 *  goal arms goal mode — the NEXT SENT MESSAGE becomes the objective),
 *  a live/paused goal with its objective, or a paused goal. Tapping a live
 *  or paused goal opens the goal card (details + pause/resume/drop/budget);
 *  tapping while armed disarms. */
export function GoalChip({
	armed,
	paused,
	objective,
	onToggle,
	onOpen,
}: {
	armed: boolean;
	/** Goal record exists but is paused (session.goal pause). */
	paused: boolean;
	objective: string;
	/** Armed state: disarm. Live/paused: open the goal card. */
	onToggle(): void;
	onOpen(): void;
}): ReactNode {
	return (
		<button
			type="button"
			className={`gui-mode-chip${armed ? " gui-mode-chip--armed" : paused ? " gui-mode-chip--goal gui-mode-chip--paused" : " gui-mode-chip--goal"}`}
			title={
				armed
					? t("next message becomes the goal objective")
					: paused
						? `${t("goal mode")} · ${t("goal status paused")} · ${objective} · ${t("click for details")}`
						: `${t("goal mode")} · ${objective} · ${t("click for details")}`
			}
			onClick={armed ? onToggle : onOpen}
		>
			<Icon name={paused ? "pause" : "target"} className="h-3 w-3" />
			<span className="max-w-[200px] truncate">{armed ? t("goal") : objective || t("goal")}</span>
			{!armed && <Icon name="more" className="h-2.5 w-2.5 opacity-60" />}
		</button>
	);
}

/** Plan-mode chip: one tap opens the plan review panel (approve/refine/
 *  exit); the attach-menu toggle still turns the mode on/off directly. */
export function PlanChip({ onOpen }: { onOpen(): void }): ReactNode {
	return (
		<button
			type="button"
			className="gui-mode-chip"
			title={`${t("plan mode")} · ${t("click for details")}`}
			onClick={onOpen}
		>
			<Icon name="compass-3" className="h-3 w-3" />
			<span>{t("plan")}</span>
			<Icon name="more" className="h-2.5 w-2.5 opacity-60" />
		</button>
	);
}
