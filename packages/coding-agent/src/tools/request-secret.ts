/**
 * `request_secret` — the agent asks the user for a credential it must use
 * inside a bash command. The tool carries only the name and purpose; the GUI
 * card collects the value, and the daemon persists it directly. The result
 * the model sees names the environment variable and never the value.
 */

import { type as arkType } from "@musepi/musepi-type";
import type { AgentTool, AgentToolResult } from "@musepi/pi-agent-core";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import { grantAgentSecret, isAgentSecretGranted } from "../secrets/agent-runtime";
import {
	type AgentSecretAnswer,
	type AgentSecretRequest,
	type AgentSecretUIContext,
	agentSecretEnvName,
	getAgentSecretStore,
	validateSecretName,
} from "../secrets/agent-store";
import type { ToolSession } from ".";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const requestSecretSchema = arkType({
	name: arkType("string").describe("environment suffix in A-Z, 0-9 and _, e.g. GITHUB_TOKEN"),
	purpose: arkType("string").describe("one line explaining what the command needs the secret for"),
});

type RequestSecretParams = typeof requestSecretSchema.infer;

export interface RequestSecretDetails {
	name: string;
	envName: string;
	status: "available" | "saved" | "cancelled";
	meta?: import("./output-meta").OutputMeta;
}

const DESCRIPTION = `Ask the user for a secret the agent needs inside a bash command.

The tool takes only a NAME and a PURPOSE. It never accepts or returns the secret value:
- If NAME is already stored and granted for this session, it returns the environment variable name immediately.
- Otherwise it opens a card for the user. Saving stores the value locally (encrypted); cancelling saves nothing.
- On success, the value reaches only bash child processes as \`$MUSEPI_SECRET_<NAME>\`.
- The model never sees the value in this tool's result, in bash output, or in a provider request.

Use this instead of asking the user to paste a key into chat. Names use A-Z, 0-9 and _ and start with a letter.`;

export class RequestSecretTool implements AgentTool<typeof requestSecretSchema, RequestSecretDetails> {
	readonly name = "request_secret";
	readonly approval = "read" as const;
	readonly label = "Request secret";
	readonly summary = "Ask the user for a secret; only its environment variable name is returned";
	readonly description = DESCRIPTION;
	readonly parameters = requestSecretSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(_toolCallId: string, params: RequestSecretParams): Promise<AgentToolResult<RequestSecretDetails>> {
		const name = validateSecretName(params.name);
		const purpose = params.purpose.trim();
		if (purpose.length === 0) throw new ToolError("Purpose must not be empty");

		const agentDir = this.session.settings.getAgentDir();
		const sessionId = this.session.getSessionId?.() ?? null;
		const store = getAgentSecretStore(agentDir);
		const envName = agentSecretEnvName(name);
		const granted = isAgentSecretGranted(agentDir, sessionId, name);

		const existing = await store.getEntry(name);
		const available = existing ? await store.available(name) : false;
		if (existing && granted && available) return this.#success(name, envName, "available");

		const ui = this.session.uiContext as (ExtensionUIContext & AgentSecretUIContext) | undefined;
		if (!ui?.requestSecret) {
			throw new ToolError(
				"This host cannot collect a secret interactively. Add it from Settings → Secrets, or expose it through secrets.yml / the environment.",
			);
		}

		const request: AgentSecretRequest = {
			name,
			purpose,
			// Stored metadata with an unreadable envelope is treated like a missing
			// value: only a fresh fill can repair it, and `allow` would fail.
			kind: existing && available ? "allow" : "fill",
		};
		const answer: AgentSecretAnswer | undefined = await ui.requestSecret(request);
		if (!answer || answer.action === "cancel") {
			return toolResult<RequestSecretDetails>({ name, envName, status: "cancelled" })
				.text(
					`Secret request for ${envName} was cancelled by the user. Nothing was saved or injected for this session.`,
				)
				.done();
		}
		if (answer.action === "allow") {
			if (!(await store.available(name))) {
				throw new ToolError(`No stored value for ${name}; the user must save one first.`);
			}
			grantAgentSecret(agentDir, sessionId, name);
			return this.#success(name, envName, "available");
		}
		// `save` is persisted by the host before the answer resolves, so the tool
		// only verifies reachability and records the session grant.
		if (!(await store.getEntry(name))) {
			throw new ToolError(`The secret ${name} was not saved; the value is still unavailable.`);
		}
		grantAgentSecret(agentDir, sessionId, name);
		return this.#success(name, envName, "saved");
	}

	#success(
		name: string,
		envName: string,
		status: RequestSecretDetails["status"],
	): AgentToolResult<RequestSecretDetails> {
		return toolResult<RequestSecretDetails>({ name, envName, status })
			.text(
				`Secret ${name} is available to bash as $${envName}. The value stays on this machine and is never returned to the model.`,
			)
			.done();
	}
}
