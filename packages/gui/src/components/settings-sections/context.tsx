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

/** Settings → 上下文: TUI context-tab parity (general/compaction/
 *  TTSR/experimental groups), schema driven. */
export function ContextSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	return (
		<>
			<h2 className="gui-settings-page-title">{t("context")}</h2>
			<SchemaTabSection rpc={rpc} tabs={["context"]} />
		</>
	);
}
