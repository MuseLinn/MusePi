import type { ReactNode } from "react";
import { ConnectorsSection } from "../../components/settings-sections/connectors";
import type { SlotComponentProps } from "../../lib/slot-host";

/** Settings → 连接器, mounted through the Cordis slot so the page can be
 *  replaced, disabled or hot-reloaded; the daemon contract is unchanged. */
export default function ConnectorsSettingsPage({ rpc, onApplyPrompt }: SlotComponentProps): ReactNode {
	return <ConnectorsSection rpc={rpc ?? null} onApplyPrompt={onApplyPrompt} />;
}
