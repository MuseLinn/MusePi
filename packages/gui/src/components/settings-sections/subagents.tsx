import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import type { RpcClient } from "../../lib/rpc";
import { SchemaTabSection } from "./schema";

/** Settings → 任务与子智能体: TUI tasks-tab parity (modes, subagent
 *  limits, isolation, commands & skills groups), schema driven — the
 *  live subagent roster lives in the session right rail (AgentsPanel),
 *  not in settings (dedupe 2026-08-11). */
export function SubagentsSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	return (
		<>
			<h2 className="gui-settings-page-title">{t("tasks & subagents")}</h2>
			<SchemaTabSection rpc={rpc} tabs={["tasks"]} />
		</>
	);
}
