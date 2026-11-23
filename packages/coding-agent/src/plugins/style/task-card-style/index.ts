import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { createTaskCardStyleExtension } from "@musepi/pi-coding-agent/musepi/swarm/task-card-style";

export const name = "musepi-task-card-style";
export const inject = [] as const;
export const provide = [] as const;

const registerTaskCardStyle = createTaskCardStyleExtension({ enabled: true });

export function apply(ctx: PluginAPI): void {
	taskCardStyle(ctx);
}

function taskCardStyle(ctx: PluginAPI): void {
	registerTaskCardStyle(ctx);
}
