/**
 * The inline approval card, at the three states a user actually meets.
 *
 * These scenarios exist because the card carries a policy decision: it is the
 * only place where a click widens what the agent may do. The risks a box and a
 * computed property can catch are the ones reading the JSX hid before — a third
 * button that crowds the row, a "quieter" action that still reads as a second
 * primary, and a prompt block that pushes the decision below the fold.
 */
import { t } from "@musepi/client-core";
import { ApprovalCard } from "../../src/components/ApprovalCard";
import { type GuiScenario, countAll, measure, mount, readElement } from "../gui-probe-helpers";

const CMD_PROMPT = [
	"Allow tool: bash",
	"Reason: sync the working tree",
	"$ git status --short",
	"Safety: no network, no destructive flags",
].join("\n");

const SELECTORS = {
	card: ".gui-approval",
	title: ".gui-approval-title",
	tool: ".gui-approval-tool",
	prompt: ".gui-approval-prompt",
	note: ".gui-approval-note textarea",
	actions: ".gui-approval-actions",
	approve: ".gui-btn-approve",
	quiet: ".gui-btn-quiet",
	deny: ".gui-btn-stop",
};

export default {
	"approval-card-exec": {
		async render(root) {
			await mount(
				<ApprovalCard requestId="r1" tool="bash" prompt={CMD_PROMPT} onDecide={() => {}} onAllowForSession={() => {}} />,
				root,
			);
		},
		async measure(body) {
			return {
				elements: measure(body, SELECTORS),
				buttons: countAll(body, ".gui-approval-actions .gui-btn"),
				// The three actions share one row; a wrapped row would put Deny on a
				// second line, away from the decision it belongs to.
				actions: readElement(body.querySelector(SELECTORS.actions)),
			};
		},
		expect: {
			// Title and tool each read as one line: a squeezed body used to break
			// the title one character per line while the buttons lost their width.
			title: { display: "block", "box.h": { min: 12, max: 32 }, "box.w": { min: 40 } },
			tool: { display: "block", "box.h": { min: 12, max: 32 } },
			// The command block is a bounded scroll area, not a page-wide wall.
			prompt: { "box.h": { min: 20, max: 180 } },
			// All three actions stay on one row with a real hit area each.
			actions: { display: "flex", "box.h": { max: 60 } },
			approve: { "box.h": { min: 20, max: 40 }, "box.w": { min: 40 } },
			quiet: { "box.h": { min: 20, max: 40 }, "box.w": { min: 80 } },
			deny: { "box.h": { min: 20, max: 40 }, "box.w": { min: 40 } },
		},
	},

	"approval-card-allow-only": {
		async render(root) {
			// No session allowance offered: the card must not leave a gap where the
			// button would be, and Approve/Deny must keep their order.
			await mount(<ApprovalCard requestId="r2" tool="write" prompt={CMD_PROMPT} onDecide={() => {}} />, root);
		},
		async measure(body) {
			return {
				elements: measure(body, SELECTORS),
				buttons: countAll(body, ".gui-approval-actions .gui-btn"),
			};
		},
		expect: {
			actions: { display: "flex", "box.h": { max: 60 } },
			// Without a session allowance the row keeps Approve and Deny at full size.
			approve: { "box.w": { min: 40 } },
			deny: { "box.w": { min: 40 } },
		},
	},
} satisfies Record<string, GuiScenario>;
