import { createBunPtyBackend } from "../../daemon/terminal-provider";
import type { TerminalRegistry } from "../../daemon/terminal-registry";
import type { ExtensionAPI } from "../../extensibility/extensions/types";

export const name = "terminal-provider-bunpty";
export const inject = ["terminal:backends"] as const;

export default function bunPty(pi: ExtensionAPI): void {
	const registry = pi.service!<TerminalRegistry>("terminal:backends");
	if (!registry) throw new Error("terminal:backends service unavailable");
	const unregister = registry.registerBackend("bun-pty", createBunPtyBackend());
	pi.effect!(unregister, "terminal-backend:bun-pty");
}
