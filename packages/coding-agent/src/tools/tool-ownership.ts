/**
 * Layered tool registry.
 *
 * A tool is resolved through three layers, farthest to nearest:
 *
 * | layer | who registers | lifetime |
 * | --- | --- | --- |
 * | `core` | the built-in factory table | process |
 * | `plugin` | capability packages (`registerToolProvider`) | package mount |
 * | `session` | tools registered on the session's extension runner | session |
 *
 * Nearer registrations shadow farther ones, and a duplicate inside one layer is
 * an error rather than a silent replacement — the same relation the reference
 * harness's registry enforces, where a nearer registration wins and a
 * same-layer collision fails. The core table is the global layer: it answers
 * only when neither a package nor the session provides the name, so a session
 * with nothing mounted behaves exactly as before.
 *
 * `pluginOwnsTool` and `extensionOwnsTool` name the track a session
 * registration came from (diagnostics); `toolIsRegistered` is the rule the
 * core factory follows, because both tracks sit in the same session layer.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentTool } from "@musepi/pi-agent-core";
import { isCapabilityActive } from "../extensibility/capability-activation";
import type { ToolSession } from ".";

/** Domain/id pair naming the component that owns a tool. */
export interface ToolOwner {
	domain: string;
	id: string;
}

/** A package-supplied implementation for a built-in tool. */
export type ToolImplementation = (
	session: ToolSession,
) => AgentTool<any, any, any> | null | Promise<AgentTool<any, any, any> | null>;

/** One plugin-layer registration. */
interface PluginRegistration {
	implementation: ToolImplementation;
	/** Component that owns the tool, when the package declares one. */
	owner?: ToolOwner;
	/** Package that registered it, for diagnostics. */
	packageName?: string;
	/** Mounts holding this registration, keyed by the mounting entry. */
	mounts: Map<string, number>;
}

/**
 * The owning mount of a registration made inside `runWithToolProviderOwner`.
 * Mounts are async, so a plain module variable could attribute one plugin's
 * registration to another; AsyncLocalStorage carries the owner across awaits.
 */
const mountOwner = new AsyncLocalStorage<string>();

/** Attribute tool-provider registrations made by `run` to one mounting entry. */
export function runWithToolProviderOwner<T>(owner: string, run: () => T): T {
	return mountOwner.run(owner, run);
}

/**
 * The plugin layer: process-wide, because a mounted package is process-wide.
 * Session-scoped registrations do not live here — they are read from the
 * session's own runner, which is what makes them shadow this layer.
 */
const pluginLayer = new Map<string, PluginRegistration>();

/** Whether a package currently provides `name` (the plugin layer). */
export function pluginProvidesTool(name: string): boolean {
	return pluginLayer.has(name);
}

/** The package-provided implementation for `name`, when the plugin layer has it. */
export function toolProviderFor(name: string): ToolImplementation | undefined {
	return pluginLayer.get(name)?.implementation;
}

/** Names the plugin layer provides. */
export function providedToolNames(): string[] {
	return [...pluginLayer.keys()].sort();
}

/**
 * Register a package-provided implementation.
 *
 * A package may be mounted more than once (host preload, then a session): a
 * second mount by the same entry joins the registration, and the name leaves
 * the layer only when its last mount releases. A *different* mount claiming the
 * same name still fails — dsh's rule that a duplicate inside one layer is a
 * composition error, with a per-agent variant belonging in that agent's scope.
 * The returned disposer removes exactly this mount's hold.
 */
export function registerToolProvider(
	name: string,
	implementation: ToolImplementation,
	options: { owner?: ToolOwner; packageName?: string } = {},
): () => void {
	const owner = mountOwner.getStore() ?? `direct:${nextDirectOwner++}`;
	const existing = pluginLayer.get(name);
	if (existing !== undefined) {
		const held = existing.mounts.get(owner) ?? 0;
		if (held === 0) {
			throw new Error(
				`tool "${name}" is already provided by the plugin layer${
					existing.packageName === undefined ? "" : ` (${existing.packageName})`
				}`,
			);
		}
		existing.mounts.set(owner, held + 1);
		return () => releaseToolProvider(name, owner);
	}
	pluginLayer.set(name, { implementation, ...options, mounts: new Map([[owner, 1]]) });
	return () => releaseToolProvider(name, owner);
}

let nextDirectOwner = 0;

function releaseToolProvider(name: string, owner: string): void {
	const entry = pluginLayer.get(name);
	if (entry === undefined) return;
	const held = entry.mounts.get(owner) ?? 0;
	if (held <= 1) entry.mounts.delete(owner);
	else entry.mounts.set(owner, held - 1);
	if (entry.mounts.size === 0) pluginLayer.delete(name);
}

/**
 * Whether a Track A plugin registered this name for the session. The core tool
 * factory yields to it, so a plugin can replace a built-in tool.
 */
export function pluginOwnsTool(session: ToolSession, name: string): boolean {
	return trackOfTool(session, name) === "plugin";
}

/**
 * Whether a Track B compatibility extension registered this name. Reported
 * separately so a diagnostic can name the track, never as the rule the core
 * factory follows — a plugin and an extension are equally near.
 */
export function extensionOwnsTool(session: ToolSession, name: string): boolean {
	return trackOfTool(session, name) === "extension";
}

/** The track whose extension registered `name`, or undefined when nobody did. */
function trackOfTool(session: ToolSession, name: string): "plugin" | "extension" | undefined {
	const extension = session.extensionRunner?.getExtensionForTool?.(name);
	return extension?.track;
}

/** Whether any track registered `name` for this session — the rule the core
 *  tool factory follows when it decides whether to construct its own copy. */
export function toolIsRegistered(session: ToolSession, name: string): boolean {
	return session.extensionRunner?.getAllRegisteredTools().some(tool => tool.definition.name === name) ?? false;
}

/**
 * The nearest layer providing `name`, or undefined when only the core table has
 * it. Track A plugin registrations and Track B extension registrations are both
 * the session layer; the process-wide package layer sits below them.
 */
export function toolLayerOf(session: ToolSession, name: string): "plugin" | "session" | undefined {
	if (toolIsRegistered(session, name)) return "session";
	if (pluginProvidesTool(name)) return "plugin";
	return undefined;
}

/**
 * Resolve the implementation for `name`, nearest layer first.
 *
 * `undefined` means "no non-core layer provides it" — the caller falls back to
 * the core factory table, which is the global layer.
 */
export function resolveToolImplementation(session: ToolSession, name: string): ToolImplementation | undefined {
	return toolLayerOf(session, name) === "plugin" ? toolProviderFor(name) : undefined;
}

/**
 * Declared owners for the tools that ship inside capability packages.
 *
 * The file families map to the four file-tools components (read / write /
 * search / index); the rest name their own single-purpose component. Tools
 * absent from this table have no owner and stay implicitly available.
 */
export const TOOL_OWNERS: Readonly<Record<string, ToolOwner>> = {
	read: { domain: "file", id: "read" },
	write: { domain: "file", id: "write" },
	edit: { domain: "file", id: "write" },
	ast_edit: { domain: "file", id: "write" },
	glob: { domain: "file", id: "search" },
	grep: { domain: "file", id: "search" },
	ast_grep: { domain: "file", id: "search" },
	computer: { domain: "tool", id: "computer" },
	lsp: { domain: "tool", id: "lsp" },
	bash: { domain: "tool", id: "bash" },
	eval: { domain: "tool", id: "eval" },
	task: { domain: "tool", id: "task" },
	hub: { domain: "tool", id: "hub" },
	web_search: { domain: "tool", id: "web_search" },
	// Session interaction: each is its own component in `tools-session`.
	ask: { domain: "tool", id: "ask" },
	todo: { domain: "tool", id: "todo" },
	notify_user: { domain: "tool", id: "notify" },
	knowledge: { domain: "tool", id: "knowledge" },
	present: { domain: "tool", id: "present" },
	office_read: { domain: "tool", id: "office" },
	workflow: { domain: "tool", id: "workflow" },
	// Skill authoring and image inspection.
	manage_skill: { domain: "tool", id: "manage_skill" },
	inspect_image: { domain: "tool", id: "inspect_image" },
	// External-dependency and session-state tools, each its own component.
	github: { domain: "tool", id: "github" },
	security_scan: { domain: "tool", id: "scan" },
	checkpoint: { domain: "tool", id: "checkpoint" },
	rewind: { domain: "tool", id: "rewind" },
	request_secret: { domain: "tool", id: "request" },
	list_secrets: { domain: "tool", id: "list" },
	debug: { domain: "tool", id: "debug" },
	connector_catalog: { domain: "tool", id: "catalog" },
	// Memory tools: each is its own component in the memory-tools package, so a
	// deployment can ship the read side without the write side.
	retain: { domain: "memory", id: "retain" },
	recall: { domain: "memory", id: "recall" },
	reflect: { domain: "memory", id: "reflect" },
	memory_edit: { domain: "memory", id: "edit" },
	learn: { domain: "memory", id: "learn" },
};

const ownerOverrides = new Map<string, ToolOwner>();

/** Claim a tool for a component. The returned disposer restores the previous owner. */
export function registerToolOwner(name: string, owner: ToolOwner): () => void {
	const previous = ownerOverrides.get(name);
	ownerOverrides.set(name, owner);
	return () => {
		if (previous === undefined) ownerOverrides.delete(name);
		else ownerOverrides.set(name, previous);
	};
}

/** The effective owner of a tool: the plugin layer's declaration, then the table. */
export function toolOwnerOf(name: string): ToolOwner | undefined {
	return ownerOverrides.get(name) ?? pluginLayer.get(name)?.owner ?? TOOL_OWNERS[name];
}

/**
 * Whether a tool may enter the slate given its owner's activation state.
 *
 * An unowned tool is allowed. An owned tool follows its component: active →
 * allowed, explicitly unloaded → not allowed.
 */
export function isToolOwnerActive(name: string): boolean {
	const owner = toolOwnerOf(name);
	if (owner === undefined || isCapabilityActive(owner.domain, owner.id)) return true;
	// A preload or re-mount can dispose the activation while the package still
	// provides the implementation process-wide. Availability follows the
	// registered implementation (dsh: a scope's view of registered tools); the
	// explicit denylists (`tools.disabled`, `disabledExtensionComponents`) stay
	// authoritative.
	return pluginProvidesTool(name);
}

/** Every tool name that currently has an owner (declared, claimed, or provided). */
export function ownedToolNames(): string[] {
	return [...new Set([...Object.keys(TOOL_OWNERS), ...ownerOverrides.keys(), ...pluginLayer.keys()])].sort();
}
