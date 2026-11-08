import type { ExtensionAPI } from "../../extensibility/extensions/types";
import { createTaskCardStyleExtension } from "../../musepi/swarm/task-card-style";

export const name = "musepi-task-card-style";
export const inject = [] as const;
export const provide = [] as const;

const registerTaskCardStyle = createTaskCardStyleExtension({ enabled: true });

export function apply(ctx: ExtensionAPI): void {
	taskCardStyle(ctx);
}

function taskCardStyle(ctx: ExtensionAPI): void {
	ctx.setLabel("Swarm 任务卡片");
	registerTaskCardStyle(ctx);
}
