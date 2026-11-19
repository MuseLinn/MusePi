import type { ReactNode } from "react";
import { IndexesSection } from "../../components/settings-sections/indexes";
import type { SlotComponentProps } from "../../lib/slot-host";

/** Settings → 索引库, mounted through the Cordis slot so the page can be
 *  replaced, disabled or hot-reloaded; the daemon contract is unchanged. */
export default function IndexLibraryPage({ rpc, cwd }: SlotComponentProps): ReactNode {
	return <IndexesSection rpc={rpc ?? null} cwd={cwd} />;
}
