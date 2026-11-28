/**
 * `request_secret` — the agent asks the user for a credential it must use
 * inside a bash command. The tool carries only the name and purpose; the GUI
 * card collects the value, and the daemon persists it directly. The result
 * the model sees names the environment variable and never the value.
 */

import { type as arkType } from "@musepi/musepi-type";
import type { AgentTool, AgentToolResult } from "@musepi/pi-agent-core";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import requestSecretDescription from "../prompts/tools/request-secret.md" with { type: "text" };
import {
	type AgentSecretAlternative,
	type AgentSecretAnswer,
	type AgentSecretRequest,
	type AgentSecretUIContext,
	agentSecretEnvName,
	getAgentSecretStore,
	type SecretDelivery,
	type SecretScope,
	secretScopeIncludes,
	validateSecretName,
} from "../secrets/agent-store";
import type { ToolSession } from ".";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const requestSecretSchema = arkType({
	name: arkType("string").describe("environment suffix in A-Z, 0-9 and _, e.g. GITHUB_TOKEN"),
	purpose: arkType("string").describe("one line explaining what the command needs the secret for"),
	delivery: arkType("string")
		.describe('"env" (default) to receive $MUSEPI_SECRET_<NAME>, or "file" for a private path')
		.optional(),
});

type RequestSecretParams = typeof requestSecretSchema.infer;

function requestedDelivery(raw: unknown): SecretDelivery {
	if (raw === undefined || raw === null || raw === "") return "env";
	if (raw === "env" || raw === "file") return raw;
	throw new ToolError('delivery must be "env" or "file"');
}

export interface RequestSecretDetails {
	name: string;
	purpose: string;
	scope: SecretScope;
	delivery: SecretDelivery;
	envName?: string;
	filePath?: string;
	status: "available" | "saved" | "cancelled";
	meta?: import("./output-meta").OutputMeta;
}

export class RequestSecretTool implements AgentTool<typeof requestSecretSchema, RequestSecretDetails> {
	readonly name = "request_secret";
	readonly approval = "read" as const;
	readonly label = "Request secret";
	readonly summary = "Ask the user for a secret; only its environment variable name or file path is returned";
	readonly description = requestSecretDescription.trim();
	readonly parameters = requestSecretSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(_toolCallId: string, params: RequestSecretParams): Promise<AgentToolResult<RequestSecretDetails>> {
		const name = validateSecretName(params.name);
		const purpose = params.purpose.trim();
		if (purpose.length === 0) throw new ToolError("Purpose must not be empty");
		const delivery = requestedDelivery(params.delivery);

		const agentDir = this.session.settings.getAgentDir();
		const store = getAgentSecretStore(agentDir);
		const envName = agentSecretEnvName(name);
		const cwd = this.session.cwd;

		// A saved, decryptable value this workspace may use is immediately usable:
		// the user's save WAS the consent, and bash injection does not gate on a
		// second per-session grant. A value saved for another workspace still
		// needs the user's permission here, so it gets the `allow` card instead.
		const existing = await store.getEntry(name);
		const readable = existing !== undefined && (await store.available(name));
		if (existing && readable && secretScopeIncludes(existing.scope, cwd)) {
			// A file delivery's working copy can be removed outside the store; the
			// path the model is about to receive must exist.
			if (existing.delivery === "file") await store.materializeFile(name);
			return this.#success(name, purpose, existing.scope, existing.delivery, "available", store.filePath(name));
		}

		const ui = this.session.uiContext as (ExtensionUIContext & AgentSecretUIContext) | undefined;
		if (!ui?.requestSecret) {
			throw new ToolError(
				"This host cannot collect a secret interactively. Add it from Settings → Vault, or expose it through secrets.yml / the environment.",
			);
		}

		const requestDelivery = existing?.delivery ?? delivery;
		// Offer what is already here so a person who saved this credential under
		// another name can pick it instead of retyping the value.
		const alternatives = await this.#alternatives(name);
		const request: AgentSecretRequest = {
			name,
			purpose,
			// A readable value outside this workspace asks to extend its scope; a
			// missing or unreadable one needs a fresh fill. A stored value keeps the
			// delivery it was saved with; this request only proposes one for a new save.
			kind: existing && readable ? "allow" : "fill",
			delivery: requestDelivery,
			workspace: cwd,
			...(alternatives.length > 0 ? { alternatives } : {}),
		};
		const answer: AgentSecretAnswer | undefined = await ui.requestSecret(request);
		if (!answer || answer.action === "cancel") {
			return toolResult<RequestSecretDetails>({
				name,
				purpose,
				scope: existing?.scope ?? "all",
				delivery: requestDelivery,
				...(requestDelivery === "env" ? { envName } : {}),
				status: "cancelled",
			})
				.text(
					`Secret request for ${name} was cancelled by the user. Nothing was saved or injected for this session.`,
				)
				.done();
		}
		// A pick means the user chose a saved entry: use that name from here on.
		// Nothing was copied, so the entry keeps its own scope and audit trail.
		const effective = answer.picked && answer.picked !== "" ? answer.picked : name;
		// `save`/`allow` are persisted by the host before the answer resolves, so
		// the tool only verifies reachability — both the value and this workspace.
		const saved = await store.getEntry(effective);
		if (!saved || !(await store.available(effective))) {
			throw new ToolError(`The secret ${effective} was not saved; the value is still unavailable.`);
		}
		if (!secretScopeIncludes(saved.scope, cwd)) {
			throw new ToolError(`The secret ${effective} is not allowed in this workspace.`);
		}
		return this.#success(effective, purpose, saved.scope, saved.delivery, "saved", store.filePath(effective));
	}

	/**
	 * Saved secrets a person might reuse for this request.
	 *
	 * Same-kind only, this workspace only, and never the name being requested:
	 * offering a credential the tool cannot use here would only send the user to
	 * a dead end. Values are never read — the list carries names and purposes.
	 */
	async #alternatives(name: string): Promise<AgentSecretAlternative[]> {
		const store = getAgentSecretStore(this.session.settings.getAgentDir());
		const cwd = this.session.cwd;
		const entries = await store.list();
		const offered: AgentSecretAlternative[] = [];
		for (const entry of entries) {
			if (entry.name === name) continue;
			if (entry.kind !== "secret") continue;
			if (!secretScopeIncludes(entry.scope, cwd)) continue;
			if (!(await store.available(entry.name))) continue;
			offered.push({ name: entry.name, purpose: entry.purpose, reason: "available" });
			if (offered.length >= 8) break;
		}
		return offered;
	}

	#success(
		name: string,
		purpose: string,
		scope: SecretScope,
		delivery: SecretDelivery,
		status: RequestSecretDetails["status"],
		filePath: string,
	): AgentToolResult<RequestSecretDetails> {
		const where = scope === "all" ? "" : " in this workspace";
		const envName = agentSecretEnvName(name);
		const details: RequestSecretDetails = {
			name,
			purpose,
			scope,
			delivery,
			status,
			...(delivery === "env" ? { envName } : { filePath }),
		};
		const text =
			delivery === "env"
				? `Secret ${name} is available to bash as $${envName}${where}. The value stays on this machine and is never returned to the model.`
				: `Secret ${name} is available as a file at ${filePath}${where}. Give that path to any command that reads one; the value stays on this machine and is never returned to the model.`;
		return toolResult<RequestSecretDetails>(details).text(text).done();
	}
}
