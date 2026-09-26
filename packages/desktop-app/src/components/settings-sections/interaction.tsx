import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import type { RpcClient } from "../../lib/rpc";
import { SchemaTabSection } from "./schema";

/** Settings → 交互: TUI interaction-tab parity (input/approvals/
 *  notifications/speech/collab/magic-keywords/startup/power/agent/
 *  language/git groups), schema driven. Group-level dedupe — each setting
 *  lives in exactly ONE tab: "Speech" → 语音 tab; "Approvals" → 工具 tab
 *  (approval policy sits next to the tool toggles it gates); "Language" →
 *  外观 tab (its picker dual-writes GUI locale + settings.locale). The
 *  end-to-end speech test lives in the 语音 tab — not duplicated here. */
export function InteractionSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	return (
		<>
			<h2 className="gui-settings-page-title">{t("interaction")}</h2>
			<SchemaTabSection rpc={rpc} tabs={["interaction"]} excludeGroups={["Speech", "Approvals", "Language"]} />
		</>
	);
}
