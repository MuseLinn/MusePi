import type { ReactNode } from "react";
import { HooksSection } from "../../components/settings-sections/hooks";
import type { SlotComponentProps } from "../../lib/slot-host";

/** Settings → 钩子 page owned by the hooks-settings Cordis plugin. */
export default function HooksSettingsPage({ rpc }: SlotComponentProps): ReactNode {
	return <HooksSection rpc={rpc ?? null} />;
}
