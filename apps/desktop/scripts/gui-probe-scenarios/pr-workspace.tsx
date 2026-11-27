/**
 * The PR/issue center's three-column workspace, as a person sees it.
 *
 * The scope tree, the row list and the detail pane share one grid. The tree is
 * a fixed label column; growing it would steal width from the list the reader
 * scans, so its width is asserted rather than left to the grid to renegotiate.
 *
 * The counts are the contract: every number in the tree is the size of the list
 * behind it, because both come from one predicate. This scenario renders the
 * same tree the pane does and checks that the active row reports its own count
 * and that a zero scope still lists (a tree that drops empty rows changes shape
 * as data arrives).
 */
import type { ReactNode } from "react";
import type { GuiScenario } from "../gui-probe-helpers";
import { countAll, measure, mount } from "../gui-probe-helpers";

type Scope = { label: string; count: number; active?: boolean };

const tree = (rows: Scope[]) => (
	<div className="gui-pr-scope" role="group" aria-label="PR filters">
		<div className="gui-pr-scope-heading">State</div>
		{rows.map(row => (
			<button
				key={row.label}
				type="button"
				className={`gui-pr-scope-row${row.active ? " gui-pr-scope-row--active" : ""}`}
				aria-pressed={row.active === true}
			>
				<span className="gui-pr-scope-label">{row.label}</span>
				<span className="gui-pr-scope-count">{row.count}</span>
			</button>
		))}
	</div>
);

const workspace = (children: ReactNode) => (
	<div className="gui-main" style={{ width: 1200, height: 640, padding: 8 }}>
		<div className="gui-pr-workspace gui-pr-workspace--scope" style={{ height: 600 }}>
			{children}
		</div>
	</div>
);

const LIST = (
	<div className="gui-pr-list">
		{Array.from({ length: 3 }, (_, index) => (
			<div key={index} className="gui-pr-row-probe" style={{ padding: "8px 10px" }}>
				<div style={{ fontSize: 13 }}>#{44 + index} DRAFT: replace software icons</div>
				<span className="gui-pr-diff">
					<span className="gui-pr-diff-bar">
						{Array.from({ length: 5 }, (_, cell) => (
							<span
								key={cell}
								className={`gui-pr-diff-cell${cell < 4 ? " gui-pr-diff-cell--add" : " gui-pr-diff-cell--del"}`}
							/>
						))}
					</span>
					<span className="gui-pr-diff-add">+74</span>
					<span className="gui-pr-diff-del">−954</span>
				</span>
			</div>
		))}
	</div>
);

const DETAIL = (
	<div className="gui-pr-detail-pane">
		<div className="gui-pr-detail" style={{ padding: 12 }}>
			<div className="gui-pr-detail-title" style={{ fontSize: 13, fontWeight: 500 }}>
				#44 DRAFT: replace software icons with the approved headset master
			</div>
		</div>
	</div>
);

const scenarios = {
	"pr-workspace-three-column": {
		capture: ".gui-main",
		async render(root: HTMLElement) {
			await mount(
				workspace(
					<>
						<div className="gui-pr-scope-tree">
							{tree([
								{ label: "Open", count: 12, active: true },
								{ label: "Drafts", count: 3 },
								{ label: "Merged", count: 148 },
								{ label: "Closed", count: 0 },
							])}
						</div>
						{LIST}
						{DETAIL}
					</>,
				),
				root,
			);
		},
		async measure(body: ParentNode) {
			return {
				elements: measure(body, {
					tree: ".gui-pr-scope-tree",
					list: ".gui-pr-list",
					detail: ".gui-pr-detail-pane",
				}),
				rows: countAll(body, ".gui-pr-scope-row"),
				activeRows: countAll(body, ".gui-pr-scope-row--active"),
				// A zero-count scope must still render: hiding it would make the
				// tree change shape between refreshes.
				zeroScopeRendered: Array.from(body.querySelectorAll(".gui-pr-scope-row")).some(
					row => row.querySelector(".gui-pr-scope-count")?.textContent === "0",
				),
				cells: countAll(body, ".gui-pr-diff-cell"),
			};
		},
		expect: {
			// The label column keeps its fixed width instead of growing.
			tree: { "box.w": 168 },
		},
	},
} satisfies Record<string, GuiScenario>;

export default scenarios;
