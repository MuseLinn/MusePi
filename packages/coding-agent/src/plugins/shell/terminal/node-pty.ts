import { createNodePtyBackend } from "@musepi/pi-coding-agent/daemon/terminal-provider";
import type { TerminalRegistry } from "@musepi/pi-coding-agent/daemon/terminal-registry";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";

export const name = "terminal-provider-nodepty";
export const inject = ["terminal:backends"] as const;

export default function nodePty(ctx: PluginAPI): void {
	const registry = ctx.service!<TerminalRegistry>("terminal:backends");
	if (!registry) throw new Error("terminal:backends service unavailable");
	const unregister = registry.registerBackend("node-pty", createNodePtyBackend());
	ctx.effect!(unregister, "terminal-backend:node-pty");
}
