import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import type { RpcClient } from "../../lib/rpc";
import { SchemaTabSection } from "./schema";

/** Settings → Shell: TUI shell-tab parity (bash/eval groups), schema
 *  driven. */
export function ShellSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	return (
		<>
			<h2 className="gui-settings-page-title">{t("shell")}</h2>
			<SchemaTabSection rpc={rpc} tabs={["shell"]} />
		</>
	);
}
