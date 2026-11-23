/**
 * `list_secrets` — names, purposes, scopes and availability for stored agent
 * secrets. Never reads a value into the result: availability is a boolean
 * derived from successful decryption, not the decrypted string.
 */

import { type as arkType } from "@musepi/musepi-type";
import type { AgentTool, AgentToolResult } from "@musepi/pi-agent-core";
import listSecretsDescription from "../prompts/tools/list-secrets.md" with { type: "text" };
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
	usable: boolean;
}

export interface ListSecretsDetails {
	entries: ListedSecret[];
	meta?: import("./output-meta").OutputMeta;
}

export class ListSecretsTool implements AgentTool<typeof listSecretsSchema, ListSecretsDetails> {
	readonly name = "list_secrets";
	readonly approval = "read" as const;
	readonly label = "List secrets";
	readonly summary = "List stored agent secret names without values";
	readonly description = listSecretsDescription.trim();
	readonly parameters = listSecretsSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(): Promise<AgentToolResult<ListSecretsDetails>> {
		const agentDir = this.session.settings.getAgentDir();
		const entries = (await listAvailableAgentSecrets(agentDir, this.session.cwd)).map(
			({ entry, available, usable }) => ({
				name: entry.name,
				purpose: entry.purpose,
				scope: entry.scope,
				available,
				usable,
			}),
		);
		if (entries.length === 0) {
			return toolResult<ListSecretsDetails>({ entries })
				.text("No agent secrets are stored. Use request_secret when a command needs a credential.")
				.done();
		}
		const lines = entries.map(entry => {
			const scope = entry.scope === "all" ? "every session" : `${entry.scope.length} workspace(s)`;
			const reach = !entry.available
				? "unavailable: value unreadable"
				: entry.usable
					? `available as $${agentSecretEnvName(entry.name)}`
					: "stored, but not usable in this workspace; ask with request_secret";
			return `- ${entry.name} — ${entry.purpose || "(no purpose recorded)"} [scope: ${scope}; ${reach}]`;
		});
		return toolResult<ListSecretsDetails>({ entries })
			.text([`Stored agent secrets (${entries.length}):`, ...lines].join("\n"))
			.done();
	}
}
