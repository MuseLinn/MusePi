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

/** Settings → 交互: TUI interaction-tab parity (input/approvals/
 *  notifications/speech/collab/magic-keywords/startup/power/agent/
 *  language/git groups), schema driven. */
export function InteractionSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	return (
		<>
			<h2 className="gui-settings-page-title">{t("interaction")}</h2>
			<SchemaTabSection rpc={rpc} tabs={["interaction"]} />
		</>
	);
}
