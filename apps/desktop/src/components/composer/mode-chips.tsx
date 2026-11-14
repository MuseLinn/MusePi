import { Pause as PauseIconData, Target as TargetIconData } from "lucide";
import { MorphIcon } from "morphicons/react";
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { Icon } from "../../vendor/oc-icons";

/** Goal-mode chip: armed state (one tap with no live
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
					? t("general.nextMessageBecomesGoal")
					: paused
						? `${t("general.goalMode")} · ${t("general.goalStatusPaused")} · ${objective} · ${t("general.clickDetails")}`
						: `${t("general.goalMode")} · ${objective} · ${t("general.clickDetails")}`
			}
			onClick={armed ? onToggle : onOpen}
		>
			<MorphIcon
				icon={paused ? PauseIconData : TargetIconData}
				size={12}
				spring="snappy"
				reducedMotion="user"
				className="h-3 w-3"
			/>
			<span className="max-w-[200px] truncate">{armed ? t("general.goal") : objective || t("general.goal")}</span>
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
			title={`${t("general.planMode")} · ${t("general.clickDetails")}`}
			onClick={onOpen}
		>
			<Icon name="compass-3" className="h-3 w-3" />
			<span>{t("tools.plan")}</span>
			<Icon name="more" className="h-2.5 w-2.5 opacity-60" />
		</button>
	);
}
