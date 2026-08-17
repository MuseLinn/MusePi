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

/** Settings → Memory: the full memory subsystem (backend choice,
 *  auto-learn, Mnemopi, Hindsight) — TUI memory-tab parity, schema
 *  driven. */
export function MemorySection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	return (
		<>
			<h2 className="gui-settings-page-title">{t("memory settings")}</h2>
			<p className="gui-settings-page-desc">{t("memory settings description")}</p>
			<SchemaTabSection rpc={rpc} tabs={["memory"]} />
		</>
	);
}
