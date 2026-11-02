import { createNodePtyBackend } from "../../daemon/terminal-provider";
import type { TerminalRegistry } from "../../daemon/terminal-registry";
import type { ExtensionAPI } from "../../extensibility/extensions/types";

export const name = "terminal-provider-nodepty";
export const inject = ["terminal:backends"] as const;

export default function nodePty(pi: ExtensionAPI): void {
	const registry = pi.service!<TerminalRegistry>("terminal:backends");
	if (!registry) throw new Error("terminal:backends service unavailable");
	const unregister = registry.registerBackend("node-pty", createNodePtyBackend());
	pi.effect!(unregister, "terminal-backend:node-pty");
}
