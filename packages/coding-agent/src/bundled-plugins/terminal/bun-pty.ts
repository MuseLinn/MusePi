import { createBunPtyBackend } from "../../daemon/terminal-provider";
import type { TerminalRegistry } from "../../daemon/terminal-registry";
import type { ExtensionAPI } from "../../extensibility/extensions/types";

export const name = "terminal-provider-bunpty";
export const inject = ["terminal:backends"] as const;

export default function bunPty(ctx: ExtensionAPI): void {
	const registry = ctx.service!<TerminalRegistry>("terminal:backends");
	if (!registry) throw new Error("terminal:backends service unavailable");
	const unregister = registry.registerBackend("bun-pty", createBunPtyBackend());
	ctx.effect!(unregister, "terminal-backend:bun-pty");
}
