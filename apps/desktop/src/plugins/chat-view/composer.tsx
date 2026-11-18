import type { ReactNode } from "react";
import { Composer } from "../../components/Composer";
import type { SlotComponentProps } from "../../lib/slot-host";

/** The chat-view plugin's own input card. It owns no state: the host passes the
 *  full composer contract (hero or session mode) and this renders the unified
 *  entry over it. Sibling plugins contribute into the composer.* sub-seats. */
export default function ComposerPage({ composer }: SlotComponentProps): ReactNode {
	return composer ? <Composer {...composer} /> : null;
}
