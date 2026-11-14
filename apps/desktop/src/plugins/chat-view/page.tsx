import type { ReactNode } from "react";
import { ChatView } from "../../components/ChatView";
import type { SlotComponentProps } from "../../lib/slot-host";

/** Render the host-owned session contract without creating a second state owner. */
export default function ChatViewPage({ chatView }: SlotComponentProps): ReactNode {
	return chatView ? <ChatView {...chatView} /> : null;
}
