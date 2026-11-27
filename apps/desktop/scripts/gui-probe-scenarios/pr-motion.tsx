/**
 * Motion in the PR list and detail.
 *
 * Two claims that a screenshot cannot state and CSS alone does not guarantee:
 *
 *  - the row's selection bar and the detail's settle are declared, and
 *  - a picked row's paint TRANSITIONS rather than snapping, because moving the
 *    selection is the most frequent gesture in this list.
 *
 * The reduced-motion path is checked too: every one of these must switch off,
 * or a reader who asked for stillness gets a list that keeps animating.
 */
import type { ReactNode } from "react";
import type { GuiScenario } from "../gui-probe-helpers";
import { mount, readElement } from "../gui-probe-helpers";

const row = (active: boolean): ReactNode => (
	<button type="button" className={`gui-changes-row gui-pr-list-row${active ? " gui-changes-row--active" : ""}`}>
		<span className="gui-pr-list-copy">
			<span className="gui-pr-list-title">#44 DRAFT: replace software icons</span>
			<span className="gui-pr-list-meta">
				<span className="gui-pr-diff">
					<span className="gui-pr-diff-bar">
						{Array.from({ length: 5 }, (_, cell) => (
							<span key={cell} className="gui-pr-diff-cell gui-pr-diff-cell--add" />
						))}
					</span>
					<span className="gui-pr-diff-add">+74</span>
					<span className="gui-pr-diff-del">−954</span>
				</span>
			</span>
		</span>
	</button>
);

const detail = (): ReactNode => (
	<div className="gui-pr-detail-pane">
		<div className="gui-pr-detail">
			<div className="gui-pr-detail-title">#44 DRAFT: replace software icons</div>
		</div>
	</div>
);

/** Declared transition/animation facts, flattened onto the measured row. */
function motionOf(root: ParentNode, selectors: Record<string, string>) {
	const out: Record<string, Record<string, unknown>> = {};
	for (const [key, selector] of Object.entries(selectors)) {
		const node = root.querySelector<HTMLElement>(selector);
		if (!node) continue;
		const style = getComputedStyle(node);
		const before = getComputedStyle(node, "::before");
		out[key] = {
			box: readElement(node)?.box,
			transitionProperty: style.transitionProperty,
			animationName: style.animationName,
			beforeTransform: before.transform,
			beforeTransition: before.transitionProperty,
		};
	}
	return out;
}

const scenarios = {
	"pr-row-motion": {
		capture: ".gui-pr-list",
		async render(root: HTMLElement) {
			await mount(
				<div className="gui-pr-list" style={{ padding: 8 }}>
					{row(true)}
					{row(false)}
				</div>,
				root,
			);
		},
		async measure(body: ParentNode) {
			return { motion: motionOf(body, { active: ".gui-changes-row--active", idle: ".gui-changes-row:not(.gui-changes-row--active)" }) };
		},
	},
	"pr-detail-settle": {
		capture: ".gui-pr-detail-pane",
		async render(root: HTMLElement) {
			await mount(detail(), root);
		},
		async measure(body: ParentNode) {
			return { motion: motionOf(body, { detail: ".gui-pr-detail" }) };
		},
	},
} satisfies Record<string, GuiScenario>;

export default scenarios;
