/**
 * Prompt host contribution contract.
 *
 * A session owns one `PromptHost`. Every contribution is placed in a scope
 * (scopes inherit from their parent) and a lane (source priority inside one
 * scope). Owners release contributions as a group, and every registration
 * also returns a disposer.
 *
 * This module is plain TypeScript: it does not import Cordis, the SDK or the
 * session runtime.
 */
import type { PromptOrder } from "./orders";
import type { PromptRenderContext, PromptTextContext } from "./registry";

/** How long rendered text may be reused without re-rendering it. */
export type PromptCacheScope = "prefix" | "snapshot" | "turn" | "request";

/** Accepted cache scopes, ordered from most stable to most volatile. */
export const PROMPT_CACHE_SCOPES: readonly PromptCacheScope[] = ["prefix", "snapshot", "turn", "request"];

/** A source lane. Later lanes in the host lane list shadow earlier ones. */
export type PromptLane = string;

/** Default lane order; the last entry has the highest priority. */
export const DEFAULT_PROMPT_LANES: readonly PromptLane[] = ["core", "extension", "preset", "session"];

/** One node in a scope chain. Child scopes inherit every ancestor contribution. */
export interface PromptScope {
	readonly name: string;
	readonly parent: PromptScope | null;
	readonly depth: number;
}

/** Where a contribution lives. Omitted fields use the host defaults. */
export interface PromptPlacement {
	scope?: PromptScope;
	lane?: PromptLane;
	owner?: string;
}

/** Render context handed to host contribution text functions. */
export interface PromptContributionContext extends PromptTextContext {
	/** Active tool names for this assembly (empty when not provided). */
	readonly activeTools: readonly string[];
	readonly cacheScope: PromptCacheScope;
	/** Set for tool providers: the canonical tool name. */
	readonly tool?: string;
	/** Set for tool providers: the active wire name that matched. */
	readonly wireName?: string;
}

export type PromptContributionText = string | ((context: PromptContributionContext) => string | null | undefined);

/** A stable prompt section. */
export interface PromptSectionContribution {
	name: string;
	order: PromptOrder;
	text: PromptContributionText;
	/**
	 * Interpolate `{{name}}` placeholders in the rendered text against
	 * registered variables (strict: unknown variables throw). Defaults to
	 * `true`; set `false` when the text carries user data (AGENTS content,
	 * memory, MCP payloads) whose braces are literal, not templates.
	 */
	interpolate?: boolean;
	/** Replaces the whole prompt; at most one may be visible. */
	complete?: boolean;
	/** Defaults to `prefix`. */
	cacheScope?: PromptCacheScope;
	owner?: string;
}

/** A volatile context contribution. Contexts are delivered by content change. */
export interface PromptContextContribution {
	name: string;
	text: PromptContributionText;
	/**
	 * Interpolate `{{name}}` placeholders in the rendered text against
	 * registered variables (strict: unknown variables throw). Defaults to
	 * `true`; set `false` when the text carries user data whose braces are
	 * literal, not templates.
	 */
	interpolate?: boolean;
	/** Defaults to `turn`. */
	cacheScope?: PromptCacheScope;
	/** Always deliver, even when the text is unchanged. */
	required?: boolean;
	owner?: string;
}

/** A prompt section owned by one tool and gated by the active tool set. */
export interface PromptToolContribution {
	/** Canonical tool name. */
	tool: string;
	/** Section name; defaults to `tool:<tool>`. */
	name?: string;
	/** Defaults to `PROMPT_ORDERS.tool`. */
	order?: PromptOrder;
	text: PromptContributionText;
	/** Alternate wire names that also activate the section. */
	wireNames?: readonly string[];
	/** Defaults to `prefix`. */
	cacheScope?: PromptCacheScope;
	owner?: string;
}

/** Assembled section with its host metadata. */
export interface PromptHostSection {
	name: string;
	order: number;
	text: string;
	/** Contribution owner; mirrors the registry's `source` field. */
	source: string;
	owner: string;
	lane: PromptLane;
	cacheScope: PromptCacheScope;
}

export interface PromptAssembly {
	revision: number;
	sections: PromptHostSection[];
	/** The single visible complete section, when one survived the cache filter. */
	complete: PromptHostSection | null;
}

/** A context message ready to deliver. */
export interface PromptContextMessage {
	name: string;
	text: string;
	cacheScope: PromptCacheScope;
	required: boolean;
	lane: PromptLane;
	owner: string;
}

export interface PromptLoadOptions {
	/** Scope to resolve against; defaults to the host root. */
	scope?: PromptScope;
	context?: PromptRenderContext;
	/** Active tool names used to gate tool providers. */
	activeTools?: readonly string[];
	/** Restrict output to one cache scope. */
	cacheScope?: PromptCacheScope | "all";
}

export interface PromptContextOptions extends PromptLoadOptions {
	/** Record returned text in the host's delivery ledger. Disable for history-led session delivery. */
	recordDelivery?: boolean;
}

export interface PromptHostOptions {
	/** Lane order, lowest priority first. Defaults to {@link DEFAULT_PROMPT_LANES}. */
	lanes?: readonly PromptLane[];
	/** Owner recorded for contributions that omit their own. */
	owner?: string;
	rootName?: string;
}
