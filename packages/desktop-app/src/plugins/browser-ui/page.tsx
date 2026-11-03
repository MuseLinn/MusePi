import type { ReactNode } from "react";
import { ManagedBrowserPane } from "../../components/ManagedBrowserPane";
import type { SlotComponentProps } from "../../lib/slot-host";

export default function ManagedBrowserPage({ browser }: SlotComponentProps): ReactNode {
	if (!browser) return null;
	return <ManagedBrowserPane open={browser.open} openRequest={browser.openRequest} onTakeover={browser.onTakeover} />;
}
