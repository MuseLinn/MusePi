import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import type { RpcClient } from "../../lib/rpc";
import { SchemaTabSection } from "./schema";

/** Settings → Files & LSP: every setting with ui metadata on the daemon's
 *  "files" tab (edit/read/summarize/lsp groups), rendered from
 *  settings.schema — the single source of truth the TUI panel uses, so
 *  the GUI can't drift from the underlying implementation. */
export function FilesLspSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	return (
		<>
			<h2 className="gui-settings-page-title">{t("files & lsp")}</h2>
			<p className="gui-settings-page-desc">{t("files & lsp settings")}</p>
			<SchemaTabSection rpc={rpc} tabs={["files"]} />
		</>
	);
}
