/**
 * Tool ownership: which plugin component owns which built-in tool, and whether
 * an extension has already registered the tool for this session.
 *
 * Two independent questions, one module:
 * - {@link extensionOwnsTool} — registration wins: an extension that registers
 *   a tool of this name replaces the core factory for the session.
 * - {@link isToolOwnerActive} — a packaged tool follows the component that
 *   owns it, so unloading or denying that component removes the tool.
 *
 * Both answer "who provides this tool", which is why they live together: a tool
 * has exactly one provider, and the core factory only runs when nobody else
 * provides it.
 */

import { isCapabilityActive } from "../extensibility/capability-activation";
import type { ToolSession } from ".";

/**
 * Registration is ownership: when an extension already registers
 * a tool with this name, the core factory must not create a second instance for
 * the session. The extension tool wins in the registry, and skipping the core
 * tool avoids duplicate work and double side effects.
 */
export function extensionOwnsTool(session: ToolSession, name: string): boolean {
	return session.extensionRunner?.getAllRegisteredTools().some(tool => tool.definition.name === name) ?? false;
}

/** Domain/id pair naming the component that owns a tool. */
export interface ToolOwner {
	domain: string;
	id: string;
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
};

const overrides = new Map<string, ToolOwner>();

/** Claim a tool for a component. The returned disposer restores the previous owner. */
export function registerToolOwner(name: string, owner: ToolOwner): () => void {
	const previous = overrides.get(name);
	overrides.set(name, owner);
	return () => {
		if (previous === undefined) overrides.delete(name);
		else overrides.set(name, previous);
	};
}

/** The effective owner of a tool: a runtime claim wins over the declared table. */
export function toolOwnerOf(name: string): ToolOwner | undefined {
	return overrides.get(name) ?? TOOL_OWNERS[name];
}

/**
 * Whether a tool may enter the slate given its owner's activation state.
 *
 * An unowned tool is allowed. An owned tool follows its component: active →
 * allowed, explicitly unloaded → not allowed.
 */
export function isToolOwnerActive(name: string): boolean {
	const owner = toolOwnerOf(name);
	return owner === undefined || isCapabilityActive(owner.domain, owner.id);
}

/** Every tool name that currently has an owner (declared or claimed). */
export function ownedToolNames(): string[] {
	return [...new Set([...Object.keys(TOOL_OWNERS), ...overrides.keys()])].sort();
}
