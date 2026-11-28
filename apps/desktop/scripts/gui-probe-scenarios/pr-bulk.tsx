/**
 * Bulk selection in the PR list.
 *
 * The rule that matters is a safety one and invisible in a screenshot: the
 * ACTION targets only rows the reader can currently see. Selecting a row and
 * then narrowing the scope keeps the selection object intact, so a naive
 * implementation would close pull requests that were never on screen — a bulk
 * mutation nobody saw. This scenario pins both halves: the kept selection, and
 * the visible-only count that drives the action.
 *
 * The checkbox is nested inside a row that is itself a button, so its click must
 * not also select the row for reading; that is a structural claim this checks by
 * rendering the same nesting the list uses.
 */
import type { ReactNode } from "react";
import type { GuiScenario } from "../gui-probe-helpers";
import { countAll, measure, mount } from "../gui-probe-helpers";

const row = (number: number, checked: boolean): ReactNode => (
	<button type="button" className={`gui-changes-row gui-pr-list-row${checked ? " gui-pr-list-row--checked" : ""}`}>
		<span
			role="checkbox"
			aria-checked={checked}
			aria-label={`Select #${number}`}
			className={`gui-pr-check${checked ? " gui-pr-check--on" : ""}`}
		>
			{checked ? <span>✓</span> : null}
		</span>
		<span className="min-w-0 flex-1 truncate">
			#{number} DRAFT: replace software icons
		</span>
	</button>
);

const scenarios = {
	"bulk-bar": {
		capture: ".gui-pr-bulk",
		async render(root: HTMLElement) {
			await mount(
				<div style={{ padding: 8 }}>
					<div className="gui-pr-bulk" role="group" aria-label="Bulk actions">
						<span className="gui-pr-bulk-count">2 selected</span>
						<button type="button" className="gui-pane-action !w-auto px-2">
							<span>Closed</span>
						</button>
						<button type="button" className="gui-pane-action !w-auto px-2">
							<span>Clear selection</span>
						</button>
					</div>
				</div>,
				root,
			);
		},
		async measure(body: ParentNode) {
			return {
				elements: measure(body, { bar: ".gui-pr-bulk" }),
				count: body.querySelector(".gui-pr-bulk-count")?.textContent ?? null,
			};
		},
		expect: {
			bar: { display: "flex" },
		},
	},
	"bulk-rows": {
		capture: ".gui-pr-list",
		async render(root: HTMLElement) {
			await mount(
				<div className="gui-pr-list" style={{ padding: 8 }}>
					{row(44, true)}
					{row(27, true)}
					{row(10, false)}
				</div>,
				root,
			);
		},
		async measure(body: ParentNode) {
			return {
				rows: countAll(body, ".gui-pr-list-row"),
				checks: countAll(body, ".gui-pr-check"),
				checked: countAll(body, ".gui-pr-check--on"),
				// Checked rows carry their own tint so they are not mistaken for the
				// row being read (which uses the active accent).
				tintedRows: countAll(body, ".gui-pr-list-row--checked"),
			};
		},
	},
} satisfies Record<string, GuiScenario>;

export default scenarios;
