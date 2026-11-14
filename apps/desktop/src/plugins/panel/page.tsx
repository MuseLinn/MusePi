import type { ReactNode } from "react";
import { ContextPanel } from "../../components/ContextPanel";
import type { SlotComponentProps } from "../../lib/slot-host";

export default function RightPanelPage({ panelShell }: SlotComponentProps): ReactNode {
	return panelShell ? <ContextPanel {...panelShell} /> : null;
}
