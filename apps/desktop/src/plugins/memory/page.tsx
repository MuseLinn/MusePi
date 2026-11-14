import type { ReactNode } from "react";
import { MemorySection } from "../../components/settings-sections/memory";
import type { SlotComponentProps } from "../../lib/slot-host";

/** Settings → 记忆 page owned by the memory Cordis plugin. */
export default function MemoryPluginPage({ rpc }: SlotComponentProps): ReactNode {
	return <MemorySection rpc={rpc ?? null} />;
}
