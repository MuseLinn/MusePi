/**
 * `list_secrets` — names, purposes, scopes and availability for stored agent
 * secrets. Never reads a value into the result: availability is a boolean
 * derived from successful decryption, not the decrypted string.
 */

import { type as arkType } from "@musepi/musepi-type";
import type { AgentTool, AgentToolResult } from "@musepi/pi-agent-core";
import listSecretsDescription from "../prompts/tools/list-secrets.md" with { type: "text" };
import { listAvailableAgentSecrets } from "../secrets/agent-runtime";
import { agentSecretEnvName, getAgentSecretStore, type SecretDelivery, type SecretScope } from "../secrets/agent-store";
import type { ToolSession } from ".";
import { toolResult } from "./tool-result";

const listSecretsSchema = arkType({});

export interface ListedSecret {
	name: string;
	purpose: string;
	/** `login` entries are filled into a page; they never become a value. */
	kind: "secret" | "login";
	scope: SecretScope;
	delivery: SecretDelivery;
	available: boolean;
	usable: boolean;
	/** For a login: the site it belongs to, so the agent can pick by page. */
	site?: string;
	username?: string;
	hasTotp?: boolean;
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
		const store = getAgentSecretStore(agentDir);
		const entries = (await listAvailableAgentSecrets(agentDir, this.session.cwd)).map(
			({ entry, available, usable }) => ({
				name: entry.name,
				purpose: entry.purpose,
				kind: entry.kind,
				scope: entry.scope,
				delivery: entry.delivery,
				available,
				usable,
				...(entry.kind === "login" && entry.login
					? {
							site: entry.login.site,
							username: entry.login.username,
							hasTotp: entry.login.hasTotp,
						}
					: {}),
			}),
		);
		if (entries.length === 0) {
			return toolResult<ListSecretsDetails>({ entries })
				.text("No agent secrets are stored. Use request_secret when a command needs a credential.")
				.done();
		}
		const lines = entries.map(entry => {
			const scope = entry.scope === "all" ? "every session" : `${entry.scope.length} workspace(s)`;
			if (entry.kind === "login") {
				// A login has no value to reach the agent; what matters is which page
				// it belongs to and whether the agent may fill it here.
				const who = entry.username ? ` for ${entry.username}` : "";
				const totp = entry.hasTotp ? ", with a 2FA code" : "";
				const reach = !entry.available
					? "unavailable: vault locked or unreadable"
					: entry.usable
						? `fill with browser action "fill_login", login "${entry.name}"`
						: "stored, but not usable in this workspace; ask with request_login";
				return `- ${entry.name} — login${who} on ${entry.site || "(no site)"}${totp} [scope: ${scope}; ${reach}]`;
			}
			const reach = !entry.available
				? "unavailable: value unreadable"
				: entry.usable
					? entry.delivery === "file"
						? `available as a file at ${store.filePath(entry.name)}`
						: `available as $${agentSecretEnvName(entry.name)}`
					: "stored, but not usable in this workspace; ask with request_secret";
			return `- ${entry.name} — ${entry.purpose || "(no purpose recorded)"} [scope: ${scope}; ${reach}]`;
		});
		return toolResult<ListSecretsDetails>({ entries })
			.text([`Stored agent secrets (${entries.length}):`, ...lines].join("\n"))
			.done();
	}
}
