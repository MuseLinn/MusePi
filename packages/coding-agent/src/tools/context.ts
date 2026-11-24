import type { AgentToolContext, ToolCallContext } from "@musepi/pi-agent-core";
import type { ConnectorConnectOutcome } from "../connectors/connect-outcome";
import type { CustomToolContext } from "../extensibility/custom-tools/types";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import type { CollabToolHandle } from "./collab";
import type { ScheduledTaskHandle } from "./schedule-task";

declare module "@musepi/pi-agent-core" {
	interface AgentToolContext extends CustomToolContext {
		ui?: ExtensionUIContext;
		hasUI?: boolean;
		toolNames?: string[];
		toolCall?: ToolCallContext;
		/** Set on `xd://` device dispatches: the write tool's outer approval gate
		 *  already resolved this call at the mounted tool's tier, so the inner
		 *  wrapper must not re-prompt for the same action (explicit per-tool
		 *  policies and overrides still apply). */
		xdevApproved?: boolean;
		/** Reports the approval tier resolved after an extension rewrites an
		 *  xd:// device call, so dispatch metadata describes the input that ran. */
		xdevTierResolved?(tier: "read" | "write" | "exec"): void;
		/** Set only after an interactive prompt approves provider computer safety checks. */
		providerSafetyApproved?: boolean;
		/** Daemon-injected collab share handle for the `collab` tool. Absent in
		 *  standalone TUI/CLI sessions (no daemon to share through). */
		collab?: CollabToolHandle;
		/** Daemon-injected scheduled-task handle for the `schedule_task` tool.
		 *  Injected rather than file-backed because the daemon owns the task
		 *  list in memory and rewrites crons.json on every change — a tool
		 *  writing that file itself would be clobbered. Absent in standalone
		 *  TUI/CLI sessions (no scheduler to register with). */
		scheduledTasks?: ScheduledTaskHandle;
		/** Daemon-injected connector enablement for `connector_catalog` action
		 *  `request`. The card decides; this runs the same `connect` the settings
		 *  page does. Absent in standalone TUI/CLI sessions. */
		connectorRequests?: { connect(id: string): Promise<ConnectorConnectOutcome> };
	}
}

export class ToolContextStore {
	#uiContext: ExtensionUIContext | undefined;
	#hasUI = false;
	#toolNames: string[] = [];
	#connectorRequests: { connect(id: string): Promise<ConnectorConnectOutcome> } | undefined;

	constructor(private readonly getBaseContext: () => CustomToolContext) {}

	getContext(toolCall?: ToolCallContext): AgentToolContext {
		return {
			...this.getBaseContext(),
			ui: this.#uiContext,
			hasUI: this.#hasUI,
			toolNames: this.#toolNames,
			toolCall,
			...(this.#connectorRequests ? { connectorRequests: this.#connectorRequests } : {}),
		};
	}

	setUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void {
		this.#uiContext = uiContext;
		this.#hasUI = hasUI;
	}

	/** Connector enablement for the agent-facing request path. */
	setConnectorRequests(port: { connect(id: string): Promise<ConnectorConnectOutcome> } | undefined): void {
		this.#connectorRequests = port;
	}

	/** The host-injected UI context, if any. Subagents forward it to their own tool session. */
	getUIContext(): ExtensionUIContext | undefined {
		return this.#uiContext;
	}

	setToolNames(names: string[]): void {
		this.#toolNames = names;
	}
}
