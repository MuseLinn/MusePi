import type { ToolSession } from ".";

/**
 * Registration is ownership (the dsh rule): when an extension already registers
 * a tool with this name, the core factory must not create a second instance for
 * the session. The extension tool wins in the registry, and skipping the core
 * tool avoids duplicate work and double side effects.
 */
export function extensionOwnsTool(session: ToolSession, name: string): boolean {
	return session.extensionRunner?.getAllRegisteredTools().some(tool => tool.definition.name === name) ?? false;
}
