/**
 * First-party magic keywords as a plugin package.
 *
 * This is the built-in keyword trio (ultrathink / orchestrate / workflowz) in
 * its plugin form: the same notices, the same gradients, the same prose
 * boundaries — `src/modes/ultrathink.ts` and friends remain the
 * implementations, and this package only DECLARES them. Declaring rather than
 * re-implementing is deliberate: the compiled-in modules are unit-tested, carry
 * the gradient machinery, and render template notices with host context that a
 * bare `registerMagicKeyword` string cannot express (orchestrate needs the
 * active tool list, workflow the task batch setting).
 *
 * What the declaration changes is visibility and control: the three keywords
 * appear here as a package the plugin system owns — listed, versioned, and
 * toggleable through the same `magicKeywords.<name>` settings keys as before.
 * Nothing about their runtime behavior changes; their settings defaults live in
 * the settings schema and are untouched.
 *
 * The compiled-in paths stay wired for now: `agent-session` reads the static
 * notices directly and the editor paints the static highlighters. This package
 * is the declaration layer the migration lands on — its entries register through
 * `pi.registerMagicKeyword` so the registry (and the extension center) sees the
 * trio as plugin contributions. The static paths remain authoritative until the
 * session-side consumption flips over, which is the next migration step.
 */
import type { ExtensionAPI } from "../../extensibility/extensions/types";
import { renderOrchestrateNotice } from "../../modes/orchestrate";
import { ULTRATHINK_NOTICE } from "../../modes/ultrathink";
import { renderWorkflowNotice } from "../../modes/workflow";

export default function magicKeywords(pi: ExtensionAPI): void {
	pi.setLabel("MusePi Magic Keywords");

	// ultrathink: full-spectrum rainbow (hue 0..330), matches the compiled-in
	// highlighter's sweep exactly.
	pi.registerMagicKeyword({
		name: "ultrathink",
		description: "Let standalone ultrathink request maximum automatic thinking and append its hidden notice",
		notice: ULTRATHINK_NOTICE,
		noticeType: "ultrathink-notice",
		highlight: { from: 0, to: 330 },
	});

	// orchestrate: cool teal→violet (hue 150..280). Its notice is a template
	// rendered per submission against the active tool list, and it DECLINES
	// when the task tool is absent — a notice demanding subagent dispatch would
	// ask for a capability the session does not have.
	pi.registerMagicKeyword({
		name: "orchestrate",
		description: "Let standalone orchestrate append its hidden multi-agent orchestration notice",
		notice: renderOrchestrateNotice({ tools: [] }),
		noticeType: "orchestrate-notice",
		renderNotice: ctx => (ctx.tools.includes("task") ? renderOrchestrateNotice({ tools: ctx.tools }) : undefined),
		highlight: { from: 150, to: 280 },
	});

	// workflowz: warm amber→green (hue 30..150). Its identity is "workflow"
	// (that is the settings key the registry and schema carry); the typed word
	// is "workflowz" — the extra z keeps it from colliding with ordinary prose
	// about workflows. The notice is a per-turn template (task batch + scout
	// availability), and it DECLINES when either driving tool is absent.
	pi.registerMagicKeyword({
		name: "workflow",
		trigger: "workflowz",
		description: "Let standalone workflowz append its hidden eval workflow notice",
		notice: renderWorkflowNotice({ taskBatch: true }),
		noticeType: "workflow-notice",
		renderNotice: ctx =>
			ctx.tools.includes("task") && ctx.tools.includes("eval")
				? renderWorkflowNotice({ taskBatch: ctx.taskBatch, scoutAvailable: ctx.scoutAvailable })
				: undefined,
		highlight: { from: 30, to: 150 },
	});

	pi.logger.info("[magic-keywords] first-party keyword package loaded (3 keywords)");
}
