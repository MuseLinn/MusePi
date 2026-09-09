import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { Icon } from "../../vendor/oc-icons";

/** Per-status glyphs for the todo panel rows (TUI todo board parity). */
const TODO_STATUS_ICONS: Record<string, string> = {
	pending: "○",
	in_progress: "◐",
	completed: "●",
	abandoned: "✕",
	blocked: "⊘",
};

/** One plan/goal phase of the session's todo board (session.modes shape). */
export interface TodoPhaseView {
	name: string;
	done: number;
	total: number;
	tasks: { content: string; status: string; blocker?: string }[];
}

/** Todo board (TUI /todo parity): per-phase progress bars, task rows with
 *  start/done/drop/remove actions, and an inline append input. Rendered
 *  inside the composer's portaled todo menu. */
export function TodoPanel({
	phases,
	onOp,
	appendText,
	onAppendChange,
}: {
	phases: TodoPhaseView[];
	onOp(op: "append" | "start" | "done" | "drop" | "rm", content?: string, phase?: string): void;
	appendText: string;
	onAppendChange(value: string): void;
}): ReactNode {
	return (
		<div className="gui-todo-panel" role="region" aria-label={t("todo list")}>
			{phases.map(phase => (
				<div key={phase.name} className="gui-todo-phase">
					<div className="gui-todo-phase-head">
						<span className="gui-todo-phase-name">{phase.name}</span>
						<span className="gui-todo-phase-count">
							{phase.done}/{phase.total}
						</span>
					</div>
					<div className="gui-todo-bar">
						<div className="gui-todo-fill" style={{ width: `${(phase.done / phase.total) * 100}%` }} />
					</div>
					{phase.tasks.map((task, i) => (
						<div key={i} className={`gui-todo-task gui-todo-task--${task.status}`}>
							<span className="gui-todo-task-icon">{TODO_STATUS_ICONS[task.status] ?? "·"}</span>
							<span className="min-w-0 flex-1 truncate" title={task.content}>
								{task.content}
							</span>
							{task.blocker && (
								<span className="gui-todo-task-blocker" title={task.blocker}>
									{task.blocker}
								</span>
							)}
							<span className="gui-todo-task-actions">
								{task.status === "pending" && (
									<button
										type="button"
										className="gui-todo-act"
										title={t("mark in progress")}
										aria-label={t("mark in progress")}
										onClick={() => onOp("start", task.content)}
									>
										<Icon name="play" className="h-3 w-3" />
									</button>
								)}
								{task.status !== "completed" && (
									<button
										type="button"
										className="gui-todo-act"
										title={t("mark done")}
										aria-label={t("mark done")}
										onClick={() => onOp("done", task.content)}
									>
										<Icon name="check" className="h-3 w-3" />
									</button>
								)}
								{task.status !== "abandoned" && task.status !== "completed" && (
									<button
										type="button"
										className="gui-todo-act"
										title={t("abandon task")}
										aria-label={t("abandon task")}
										onClick={() => onOp("drop", task.content)}
									>
										<Icon name="close" className="h-3 w-3" />
									</button>
								)}
								<button
									type="button"
									className="gui-todo-act"
									title={t("remove task")}
									aria-label={t("remove task")}
									onClick={() => onOp("rm", task.content)}
								>
									<Icon name="delete-bin" className="h-3 w-3" />
								</button>
							</span>
						</div>
					))}
					<div className="gui-todo-append">
						<input
							className="gui-todo-append-input"
							value={appendText}
							onChange={e => onAppendChange(e.target.value)}
							onKeyDown={e => {
								if (e.key === "Enter") {
									e.preventDefault();
									if (appendText.trim()) {
										onOp("append", appendText.trim(), phase.name);
										onAppendChange("");
									}
								}
							}}
							placeholder={t("add a task…")}
							aria-label={t("add a task…")}
						/>
						<button
							type="button"
							className="gui-todo-act gui-todo-act--add"
							title={t("add task")}
							aria-label={t("add task")}
							disabled={!appendText.trim()}
							onClick={() => {
								if (appendText.trim()) {
									onOp("append", appendText.trim(), phase.name);
									onAppendChange("");
								}
							}}
						>
							<Icon name="add" className="h-3 w-3" />
						</button>
					</div>
				</div>
			))}
		</div>
	);
}
