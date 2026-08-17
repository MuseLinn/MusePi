import {
	t,
} from "@musepi/desktop-web";
import type {
	ReactNode,
} from "react";
import type {
	RpcClient,
} from "../../lib/rpc";
import { SchemaTabSection } from "./schema";


/** Settings → 工具: TUI tools-tab parity (available tools/todos/grep &
 *  browser/computer/github/output-limits/execution/discovery/dev groups),
 *  schema driven. */
export function ToolsSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	return (
		<>
			<h2 className="gui-settings-page-title">{t("tools")}</h2>
			<SchemaTabSection rpc={rpc} tabs={["tools"]} />
		</>
	);
}
