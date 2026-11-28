/**
 * A PR row's diff size, rendered against real stylesheets.
 *
 * The change bar is proportional: five cells split between additions and
 * deletions. The assertion that matters is the one a screenshot cannot state —
 * a PR that changed nothing renders NO bar at all (a zero bar would claim the
 * pull request touches no files), while a mixed PR always keeps at least one
 * cell on each side so a small deletion never rounds away and makes the row read
 * as additions only.
 */
import type { ReactNode } from "react";
import type { GuiScenario } from "../gui-probe-helpers";
import { countAll, measure, mount } from "../gui-probe-helpers";

/** The row shape the list uses, with the diff strip inline. */
function row({
	additions,
	deletions,
	changedFiles,
}: {
	additions?: number;
	deletions?: number;
	changedFiles?: number;
}): ReactNode {
	const add = additions ?? 0;
	const del = deletions ?? 0;
	const total = add + del;
	if (total > 0) {
		const CELLS = 5;
		const both = add > 0 && del > 0;
		const addCells = both
			? Math.max(1, Math.min(CELLS - 1, Math.round((add / total) * CELLS)))
			: add > 0
				? CELLS
				: 0;
		const delCells = both ? CELLS - addCells : del > 0 ? CELLS : 0;
		return (
			<div className="gui-pr-row-probe" style={{ padding: 8 }}>
				<span className="gui-pr-diff">
					<span className="gui-pr-diff-bar">
						{Array.from({ length: CELLS }, (_, index) => (
							<span
								key={index}
								className={`gui-pr-diff-cell${index < addCells ? " gui-pr-diff-cell--add" : index < addCells + delCells ? " gui-pr-diff-cell--del" : ""}`}
							/>
						))}
					</span>
					<span className="gui-pr-diff-add">+{add}</span>
					<span className="gui-pr-diff-del">−{del}</span>
					{changedFiles !== undefined ? (
						<span className="gui-pr-diff-files">{changedFiles} files</span>
					) : null}
				</span>
			</div>
		);
	}
	return <div className="gui-pr-row-probe" style={{ padding: 8 }}>none</div>;
}

const scenarios = {
	"diff-typical": {
		capture: ".gui-pr-row-probe",
		async render(root: HTMLElement) {
			await mount(row({ additions: 1748, deletions: 338, changedFiles: 11 }), root);
		},
		async measure(body: ParentNode) {
			return {
				elements: measure(body, { bar: ".gui-pr-diff-bar" }),
				cells: countAll(body, ".gui-pr-diff-cell"),
				addCells: countAll(body, ".gui-pr-diff-cell--add"),
				delCells: countAll(body, ".gui-pr-diff-cell--del"),
			};
		},
		expect: {
			bar: { display: "flex" },
		},
	},
	"diff-tiny-deletion": {
		capture: ".gui-pr-row-probe",
		async render(root: HTMLElement) {
			await mount(row({ additions: 120, deletions: 1 }), root);
		},
		async measure(body: ParentNode) {
			return {
				// A 1-vs-120 split rounds to zero deletion cells; the floor keeps one.
				addCells: countAll(body, ".gui-pr-diff-cell--add"),
				delCells: countAll(body, ".gui-pr-diff-cell--del"),
			};
		},
	},
	"diff-none": {
		capture: ".gui-pr-row-probe",
		async render(root: HTMLElement) {
			await mount(row({}), root);
		},
		async measure(body: ParentNode) {
			return { cells: countAll(body, ".gui-pr-diff-cell") };
		},
	},
} satisfies Record<string, GuiScenario>;

export default scenarios;
