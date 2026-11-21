/**
 * `list_secrets` — names, purposes, scopes and availability for stored agent
 * secrets. Never reads a value into the result: availability is a boolean
 * derived from successful decryption, not the decrypted string.
 */

import { type as arkType } from "@musepi/musepi-type";
import type { AgentTool, AgentToolResult } from "@musepi/pi-agent-core";
import { listAvailableAgentSecrets } from "../secrets/agent-runtime";
import { agentSecretEnvName, type SecretScope } from "../secrets/agent-store";
import type { ToolSession } from ".";
import { toolResult } from "./tool-result";

const listSecretsSchema = arkType({});

export interface ListedSecret {
	name: string;
	purpose: string;
	scope: SecretScope;
	available: boolean;
}

export interface ListSecretsDetails {
	entries: ListedSecret[];
	meta?: import("./output-meta").OutputMeta;
}

const DESCRIPTION = `List the agent secrets stored on this machine.

Each entry shows its name, purpose, scope and whether a usable value exists.
Values are never included: the model can only reach a secret inside a bash
child process as \`$MUSEPI_SECRET_<NAME>\`. Use \`request_secret\` when a needed
name is missing.`;

export class ListSecretsTool implements AgentTool<typeof listSecretsSchema, ListSecretsDetails> {
	readonly name = "list_secrets";
	readonly approval = "read" as const;
	readonly label = "List secrets";
	readonly summary = "List stored agent secret names without values";
	readonly description = DESCRIPTION;
	readonly parameters = listSecretsSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(): Promise<AgentToolResult<ListSecretsDetails>> {
		const agentDir = this.session.settings.getAgentDir();
		const entries = (await listAvailableAgentSecrets(agentDir)).map(({ entry, available }) => ({
			name: entry.name,
			purpose: entry.purpose,
			scope: entry.scope,
			available,
		}));
		if (entries.length === 0) {
			return toolResult<ListSecretsDetails>({ entries })
				.text("No agent secrets are stored. Use request_secret when a command needs a credential.")
				.done();
		}
		const lines = entries.map(
			entry =>
				`- ${entry.name} — ${entry.purpose || "(no purpose recorded)"} [scope: ${entry.scope}, ${
					entry.available ? `available as $${agentSecretEnvName(entry.name)}` : "unavailable: value unreadable"
				}]`,
		);
		return toolResult<ListSecretsDetails>({ entries })
			.text([`Stored agent secrets (${entries.length}):`, ...lines].join("\n"))
			.done();
	}
}
