import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { SchemaTabSection } from "../../components/settings-sections/schema";
import type { SlotComponentProps } from "../../lib/slot-host";

/** Settings → Files & LSP: every setting with ui metadata on the daemon's
 *  "files" tab (edit/read/summarize/lsp groups), rendered from
 *  settings.schema — the single source of truth the TUI panel uses, so
 *  the GUI can't drift from the underlying implementation. */
export default function FilesSettingsPage({ rpc }: SlotComponentProps): ReactNode {
	return (
		<>
			<h2 className="gui-settings-page-title">{t("general.filesLsp")}</h2>
			<p className="gui-settings-page-desc">{t("general.filesLspSettings")}</p>
			<SchemaTabSection rpc={rpc ?? null} tabs={["files"]} />
		</>
	);
}
