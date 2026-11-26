import { t } from "@musepi/client-core";
import { ToolView } from "@musepi/client-core/src/tool-render/ToolView";
import { taskRenderer } from "@musepi/client-core/src/tool-render/tools/task";
import type { ReactNode } from "react";

/** Shared fixture feeding both preview cards — the SAME settled-batch shape
 *  the transcript renders (results with per-agent stats/errors). */
const TASK_PREVIEW_ARGS = { tasks: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }] };
const TASK_PREVIEW_DETAILS = {
	totalDurationMs: 42500,
	results: [
		{ id: "A", exitCode: 0, durationMs: 3000, tokens: 1200, output: "Scanned the openchamber tree" },
		{ id: "B", exitCode: 0, durationMs: 4100, tokens: 900, output: "Summarized composer slots" },
		{ id: "C", exitCode: 0, durationMs: 5200, tokens: 1500, output: "Mapped the settings sections" },
		{ id: "D", exitCode: 1, durationMs: 1900, error: "exit 1", output: "timed out" },
	],
};

/** Preview of the two task-card styles (display.taskCardStyle settings
 *  row): MusePi Swarm = the chat-message task tool-call card with the
 *  floating frosted member-grid card beneath it (the composer chip opens
 *  that floating card); MusePi original (Classic) = the plain tool-call card
 *  only. The cards ARE the real transcript rendering driven by a shared
 *  fixture (same ToolView / taskRenderer.SwarmCard the chat uses) — what
 *  you see is what the style will look like; clicking either card switches
 *  the style (the preview IS the control; the standard select is hidden). */
export function TaskCardStylePreview({
	value,
	onPick,
}: {
	value: unknown;
	onPick(style: "swarm" | "classic"): void;
}): ReactNode {
	const active = value === "classic" ? "classic" : "swarm";
	// The task renderer always ships SwarmCard (the swarm member grid) —
	// non-null asserted like the renderer tests, the field is optional by
	// ToolRenderer contract but present here.
	const SwarmCard = taskRenderer.SwarmCard!;
	const nativeCard = (
		<ToolView
			name="task"
			args={TASK_PREVIEW_ARGS}
			result={{ content: [], details: TASK_PREVIEW_DETAILS }}
			taskCardStyle="classic"
			defaultOpen
			collapseWhenDone={false}
		/>
	);
	const classic = <div className="gui-taskstyle-preview-stack">{nativeCard}</div>;
	const swarm = (
		<div className="gui-taskstyle-preview-stack">
			{nativeCard}
			{/* Floating member grid (composer chip → frosted card): the real
			 * taskRenderer.SwarmCard — avatars, progress bars, accordions. */}
			<div className="gui-taskstyle-preview-float">
				<SwarmCard name="task" args={{}} result={{ content: [], details: TASK_PREVIEW_DETAILS }} />
			</div>
		</div>
	);
	return (
		<div className="gui-taskstyle-preview">
			<button
				type="button"
				className={`gui-taskstyle-preview-option${active === "swarm" ? " gui-taskstyle-preview-option--active" : ""}`}
				aria-pressed={active === "swarm"}
				onClick={() => onPick("swarm")}
			>
				{swarm}
				<span className="gui-taskstyle-preview-label">{t("settings.musepiSwarm")}</span>
			</button>
			<button
				type="button"
				className={`gui-taskstyle-preview-option${active === "classic" ? " gui-taskstyle-preview-option--active" : ""}`}
				aria-pressed={active === "classic"}
				onClick={() => onPick("classic")}
			>
				{classic}
				<span className="gui-taskstyle-preview-label">{t("settings.musepiOriginal")}</span>
			</button>
		</div>
	);
}
