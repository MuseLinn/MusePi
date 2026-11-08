import { createNodePtyBackend } from "../../daemon/terminal-provider";
import type { TerminalRegistry } from "../../daemon/terminal-registry";
import type { ExtensionAPI } from "../../extensibility/extensions/types";

export const name = "terminal-provider-nodepty";
export const inject = ["terminal:backends"] as const;

export default function nodePty(ctx: ExtensionAPI): void {
	const registry = ctx.service!<TerminalRegistry>("terminal:backends");
	if (!registry) throw new Error("terminal:backends service unavailable");
	const unregister = registry.registerBackend("node-pty", createNodePtyBackend());
	ctx.effect!(unregister, "terminal-backend:node-pty");
}
