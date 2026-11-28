/**
 * `request_login` — the agent needs to sign in to a website and must not be
 * given the password.
 *
 * The card collects the site, username, password and an optional 2FA setup key;
 * the daemon stores them as a `login` entry. Afterwards the browser tool fills
 * the form itself (`action: "fill_login"`), so the password and any one-time
 * code never enter the transcript, a tool result, or a provider request.
 */

import { type as arkType } from "@musepi/musepi-type";
import type { AgentTool, AgentToolResult } from "@musepi/pi-agent-core";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import requestLoginDescription from "../prompts/tools/request-login.md" with { type: "text" };
import {
	type AgentSecretAnswer,
	type AgentSecretRequest,
	type AgentSecretUIContext,
	getAgentSecretStore,
	secretScopeIncludes,
	validateSecretName,
} from "../secrets/agent-store";
import type { ToolSession } from ".";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const requestLoginSchema = arkType({
	name: arkType("string").describe("name for this login in A-Z, 0-9 and _, e.g. ACME_PORTAL"),
	site: arkType("string").describe("the site to sign in to, e.g. example.com"),
	purpose: arkType("string").describe("one line explaining what you are doing on that site"),
});

type RequestLoginParams = typeof requestLoginSchema.infer;

export interface RequestLoginDetails {
	name: string;
	site: string;
	status: "available" | "saved" | "cancelled";
	/** The tool that will use it; the agent never receives a password. */
	fillWith: "browser";
	meta?: import("./output-meta").OutputMeta;
}

export class RequestLoginTool implements AgentTool<typeof requestLoginSchema, RequestLoginDetails> {
	readonly name = "request_login";
	readonly approval = "read" as const;
	readonly label = "Request login";
	readonly summary = "Ask the user to save a website sign-in; only the name comes back";
	readonly description = requestLoginDescription.trim();
	readonly parameters = requestLoginSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(_toolCallId: string, params: RequestLoginParams): Promise<AgentToolResult<RequestLoginDetails>> {
		const name = validateSecretName(params.name);
		const purpose = params.purpose.trim();
		if (purpose.length === 0) throw new ToolError("Purpose must not be empty");
		const site = params.site.trim().toLowerCase();
		if (site === "") throw new ToolError("site must not be empty");

		const store = getAgentSecretStore(this.session.settings.getAgentDir());
		const cwd = this.session.cwd;

		// A login that already covers this site and workspace answers without a
		// card, whatever name it carries: the name the agent picked is a label,
		// not the identity of the credential. Filling is not a second use of the
		// value either, so the earlier save stands as consent.
		for (const candidate of await store.loginsForHost(site)) {
			if (!secretScopeIncludes(candidate.scope, cwd)) continue;
			if (await store.available(candidate.name)) {
				return this.#done(candidate.name, candidate.login?.site ?? site, "available");
			}
		}

		const ui = this.session.uiContext as (ExtensionUIContext & AgentSecretUIContext) | undefined;
		if (!ui?.requestSecret) {
			throw new ToolError(
				"This host cannot collect a login interactively. Add one from Settings → Vault, then call this again.",
			);
		}

		// Other logins for this site are offered too: a person with two accounts
		// there can pick the right one on the card instead of retyping it.
		const alternatives = (await store.loginsForHost(site))
			.filter(candidate => candidate.name !== name && secretScopeIncludes(candidate.scope, cwd) && candidate.login)
			.slice(0, 8)
			.map(candidate => ({
				name: candidate.name,
				purpose: candidate.purpose,
				site: candidate.login?.site,
				username: candidate.login?.username,
				reason: "same-site" as const,
			}));
		const request: AgentSecretRequest = {
			name,
			purpose,
			kind: "login",
			site,
			workspace: cwd,
			...(alternatives.length > 0 ? { alternatives } : {}),
		};
		const answer: AgentSecretAnswer | undefined = await ui.requestSecret(request);
		if (!answer || answer.action === "cancel") {
			return toolResult<RequestLoginDetails>({
				name,
				site,
				status: "cancelled",
				fillWith: "browser",
			})
				.text(`The user did not save a login for ${site}. Nothing was stored.`)
				.done();
		}
		// A pick identifies an existing login by name; that is the one to fill.
		if (answer.picked && answer.picked !== "") {
			const picked = await store.getEntry(answer.picked);
			return this.#done(answer.picked, picked?.login?.site ?? site, "available");
		}
		if (answer.action === "allow") {
			// The card extended this workspace's access to an existing entry.
			const entry = await store.getEntry(name);
			return this.#done(name, site, "available");
		}
		return this.#done(name, site, "saved");
	}

	#done(name: string, site: string, status: "available" | "saved"): AgentToolResult<RequestLoginDetails> {
		return toolResult<RequestLoginDetails>({ name, site, status, fillWith: "browser" })
			.text(
				status === "saved"
					? `Saved a login for ${site} as ${name}. Sign in with the browser tool: action "fill_login", login "${name}". You will not see the password or any 2FA code.`
					: `${name} already has a login for ${site}. Use the browser tool: action "fill_login", login "${name}".`,
			)
			.done();
	}
}
