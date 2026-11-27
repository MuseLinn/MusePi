/**
 * The inline approval card, at the three states a user actually meets.
 *
 * These scenarios exist because the card carries a policy decision: it is the
 * only place where a click widens what the agent may do. The risks a box and a
 * computed property can catch are the ones reading the JSX hid before — a third
 * button that crowds the row, a "quieter" action that still reads as a second
 * primary, and a prompt block that pushes the decision below the fold.
 *
 * Known limitation of this probe, not of the card: the semantic `--color-*`
 * tokens resolve to the same values in both themes here, so the dark capture
 * shows the light palette. Layout, hierarchy and geometry are still worth
 * checking on both; colour parity needs the real window.
 */
import { t } from "@musepi/client-core";
import { ApprovalCard } from "../../src/components/ApprovalCard";
import { type GuiScenario, countAll, measure, mount, readElement } from "../gui-probe-helpers";

/**
 * The prompts below are built from the SAME translation keys the daemon uses, so
 * the fixture cannot drift from the real format in either language. Writing the
 * English literal once was enough to make the card's localized parser find
 * nothing — and to make a "safety" line look like part of the format.
 */
const label = (key: string): string => t(key as Parameters<typeof t>[0]);
const promptLine = (head: string, body: string): string => `${head}: ${body}`;

const CMD_PROMPT = [
	promptLine(label("Allow tool"), "bash"),
	promptLine(label("Reason"), "sync the working tree"),
	promptLine("Command", "git status --short"),
].join("\n");

/** An MCP tool: the prompt adds the origin line because approving crosses a server. */
const MCP_PROMPT = [
	promptLine(label("Allow tool"), "mcpsearch"),
	label("Origin: MCP server tool"),
	promptLine(label("Reason"), "find the issue that reported this"),
	promptLine("Command", "gh search issues --label bug"),
].join("\n");

const SELECTORS = {
	card: ".gui-approval-card",
	title: ".gui-approval-title",
	tool: ".gui-approval-tool",
	prompt: ".gui-approval-prompt",
	note: ".gui-approval-note",
	origin: ".gui-approval-origin",
	reason: ".gui-approval-reason",
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
			// The reason reads as a sentence above the evidence, not as the first
			// line of the command block.
			reason: { display: "block", "box.h": { min: 12, max: 40 } },
			// All three actions stay on one row with a real hit area each.
			actions: { display: "flex", "box.h": { max: 60 } },
			approve: { "box.h": { min: 20, max: 40 }, "box.w": { min: 40 } },
			quiet: { "box.h": { min: 20, max: 40 }, "box.w": { min: 80 } },
			deny: { "box.h": { min: 20, max: 40 }, "box.w": { min: 40 } },
		},
	},

	"approval-card-mcp-origin": {
		async render(root) {
			await mount(
				<ApprovalCard
					requestId="r3"
					tool="mcpsearch"
					prompt={MCP_PROMPT}
					onDecide={() => {}}
				/>,
				root,
			);
		},
		async measure(body) {
			// `Origin:` is real prompt data, so it has to survive into the card
			// rather than being flattened into the command well; `measure` reports
			// it as an element reading, which is what `expect` compares against.
			return { elements: measure(body, SELECTORS) };
		},
		expect: {
			// The origin tag rides the identity line at the quietest weight.
			origin: { display: "block", "box.h": { min: 10, max: 28 } },
			// The detail line keeps its own label — `Command:` says what follows.
			prompt: { display: "block", "box.h": { min: 14, max: 180 } },
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
