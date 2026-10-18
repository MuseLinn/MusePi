import type { ReactNode } from "react";
import { openPlanFromChat } from "../../components/transcript/canvas-jump.js";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { isRecord, str } from "../util";

/**
 * `knowledge` tool renderer — project notes / todos / plans.
 *
 * Most actions need no card: the model already narrates "saved a note", and a
 * second box saying the same thing is noise. Two cases earn one:
 *
 *  - `show`: the whole point of the action is that the USER looks at the plan,
 *    so the card carries the jump into the project-knowledge panel. Without it
 *    the model would claim to have opened something the user never saw.
 *  - a rejected call (conflict / unknown id): the reason is what the user needs
 *    to act on, and the generic error row hides it behind "error".
 */

interface KnowledgeDetails {
	action?: string;
	kind?: string;
	id?: string;
	projectId?: string;
	showPlan?: { id?: string; title?: string; directory?: string };
	todo?: { id?: string; text?: string; done?: boolean };
}

function detailsOf(result: unknown): KnowledgeDetails {
	if (!isRecord(result)) return {};
	const details = isRecord(result.details) ? result.details : null;
	if (!details) return {};
	const showPlan = isRecord(details.showPlan)
		? {
				id: str(details.showPlan.id) ?? undefined,
				title: str(details.showPlan.title) ?? undefined,
				directory: str(details.showPlan.directory) ?? undefined,
			}
		: undefined;
	return {
		action: str(details.action) ?? undefined,
		kind: str(details.kind) ?? undefined,
		id: str(details.id) ?? undefined,
		projectId: str(details.projectId) ?? undefined,
		showPlan,
		todo: isRecord(details.todo)
			? {
					id: str(details.todo.id) ?? undefined,
					text: str(details.todo.text) ?? undefined,
					done: details.todo.done === true,
				}
			: undefined,
	};
}

/** The plan a `show` call asked to open, or null for any other call. */
function planToShow(result: unknown): { id: string; title: string; directory: string } | null {
	const details = detailsOf(result);
	const plan = details.showPlan;
	if (!plan?.id || !plan.directory) return null;
	return { id: plan.id, title: plan.title ?? plan.id, directory: plan.directory };
}

function Summary({ result }: ToolRenderProps): ReactNode {
	if (result?.isError) {
		// The reason (a conflict, a missing id) is the actionable part.
		const text = (result.content ?? [])
			.map(block => (block.type === "text" && "text" in block ? String(block.text) : ""))
			.join(" ")
			.trim();
		return <span className="tv-knowledge-failed">{text || "knowledge call failed"}</span>;
	}
	const details = detailsOf(result);
	if (details.action === "show" && details.showPlan) {
		return <span>{`已打开计划「${details.showPlan.title ?? details.showPlan.id}」`}</span>;
	}
	if (details.todo) {
		return <span>{`${details.todo.done ? "✓" : "○"} ${details.todo.text ?? ""}`}</span>;
	}
	const kind = details.kind ? `${details.kind} ` : "";
	switch (details.action) {
		case "list":
			return <span>project knowledge</span>;
		case "save":
			return <span>{`saved ${kind}`.trim()}</span>;
		case "delete":
			return <span>{`deleted ${kind}`.trim()}</span>;
		default:
			return <span>knowledge</span>;
	}
}

/**
 * `show` body: the jump card. Clicking dispatches the shell event the panel
 * listens for; a host with no plan surface simply has nothing to click, so the
 * card explains that instead of offering a dead button.
 */
function Body({ result }: ToolRenderProps): ReactNode {
	const plan = planToShow(result);
	if (!plan) return null;
	// Same visual language as the board / scheduled-task jump cards: one chat →
	// panel affordance, so all three read as one family.
	return (
		<button type="button" className="tr-canvas-jump" onClick={() => openPlanFromChat(plan.directory, plan.id, plan.title)}>
			<span className="tr-canvas-jump-icon" aria-hidden="true">
				▤
			</span>
			<span className="tr-canvas-jump-text">
				<span className="tr-canvas-jump-title">{plan.title}</span>
				<span className="tr-canvas-jump-sub">在项目知识中打开</span>
			</span>
			<span className="tr-canvas-jump-arrow" aria-hidden="true">
				→
			</span>
		</button>
	);
}

export const knowledgeRenderer: ToolRenderer = {
	Summary,
	Body,
};
