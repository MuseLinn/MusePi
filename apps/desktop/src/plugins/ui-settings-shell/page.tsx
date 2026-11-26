import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { SchemaTabSection } from "../../components/settings-sections/schema";
import type { SlotComponentProps } from "../../lib/slot-host";
import { ShellMinimizerStatsCard } from "./shell-minimizer-stats";

/** Settings → Shell: TUI shell-tab parity (bash/eval groups), schema
 *  driven. */
export default function ShellSettingsPage({ rpc }: SlotComponentProps): ReactNode {
	return (
		<>
			<h2 className="gui-settings-page-title">{t("settings.shell")}</h2>
			<SchemaTabSection rpc={rpc ?? null} tabs={["shell"]} />
			<ShellMinimizerStatsCard rpc={rpc ?? null} />
		</>
	);
}
