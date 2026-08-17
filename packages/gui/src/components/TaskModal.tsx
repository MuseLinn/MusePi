import { t } from "@musepi/desktop-web/src/i18n/index.js";
import { GuiSelect } from "./GuiSelect";
import { hasTask, type WidgetTask } from "@musepi/desktop-web/src/widgets/task";
import type { ReactNode } from "react";
import { useState } from "react";
import { useTwoPhaseEnter } from "../lib/use-two-phase-enter";
import { Icon } from "../vendor/oc-icons";

/**
 * Widget task modal (kimi 小组件任务 parity): task status toggle, name,
 * description and recent runs. Opened from the card menu's 查看任务 and
 * from the focus modal. `update` persists changes into widget data.
 */
export function TaskModal({
	task,
	update,
	onClose,
}: {
	task: WidgetTask;
	update(patch: { task: WidgetTask }): void;
	onClose(): void;
}): ReactNode {
	const [closing, setClosing] = useState(false);
	// Two-phase enter: the frosted scrim paints at opacity 0 first so the
	// backdrop composites before gui-fade-in (mount-frame animation on a
	// backdrop-filter element kills the frost — gui-implementation.md §6.5).
	const enteredCls = useTwoPhaseEnter(true);
	const close = (): void => {
		if (closing) return;
		setClosing(true);
		setTimeout(onClose, 150);
	};
	return (
		<div
			className={`gui-task-modal${enteredCls ? " gui-task-modal--entered" : ""}${closing ? " gui-task-modal--closing" : ""}`}
			role="dialog"
			aria-modal="true"
			onClick={close}
		>
			<div className="gui-task-modal-card" onClick={e => e.stopPropagation()}>
				<div className="gui-task-modal-head">
					<span className="gui-task-modal-title">{t("widget task modal")}</span>
					<button type="button" className="gui-tool-btn" onClick={close} aria-label={t("close")}>
						<Icon name="close" className="h-4 w-4" />
					</button>
				</div>
				<div className="gui-task-modal-body">
					<div className="gui-task-row">
						<span className="gui-task-label">{t("widget task status")}</span>
						<button
							type="button"
							className={`gui-toggle${task.enabled ? " gui-toggle--on" : ""}`}
							role="switch"
							aria-checked={task.enabled}
							onClick={() => update({ task: { ...task, enabled: !task.enabled } })}
						>
							<span className="gui-toggle-thumb" />
						</button>
					</div>
					<div className="gui-task-row">
						<span className="gui-task-label">{t("widget task schedule")}</span>
						<GuiSelect
					className="gui-settings-select"
					value={task.schedule ?? "manual"}
					onChange={v => update({ task: { ...task, schedule: v as WidgetTask["schedule"] } })}
					options={[{ value: "manual", label: t("widget task manual") }, { value: "hourly", label: t("widget task hourly") }, { value: "daily", label: t("widget task daily") }]}
				/>
					</div>
					<div className="gui-task-field">
						<span className="gui-task-label">{t("widget task name")}</span>
						<input className="gui-task-input" value={task.name} readOnly />
					</div>
					<div className="gui-task-field">
						<span className="gui-task-label">{t("widget task desc")}</span>
						<textarea className="gui-task-input gui-task-textarea" value={task.desc} readOnly rows={2} />
					</div>
					<div className="gui-task-field">
						<span className="gui-task-label">{t("widget task runs")}</span>
						<div className="gui-task-runs">
							{task.runs.length === 0 && <span className="gui-task-runs-empty">{t("widget task no runs")}</span>}
							{task.runs.map((run, i) => (
								<div key={`${run.time}-${i}`} className="gui-task-run">
									<span className="gui-task-run-time">{run.time}</span>
									<span className={`gui-task-run-dot${run.success ? "" : " gui-task-run-dot--fail"}`} />
									<span className="gui-task-run-status">
										{run.success ? t("widget task success") : t("widget task failed")}
									</span>
								</div>
							))}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

/** True when the widget data carries a runnable task. */
export function widgetHasTask(data: Record<string, unknown>): boolean {
	return hasTask(data);
}
