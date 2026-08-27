import { type ComponentType, createElement, memo, type ReactNode } from "react";
import type { MusePiCompatHost } from "../components/transcript/Transcript";

/**
 * Compat slot host (dsh-desktop plugin parity, extended/enhanced modes): the
 * `musepi serve` injected script registers daemon-compiled extension
 * components on window.MusePiCompatHost (keyed by slot). This component
 * renders every component registered for one slot, in registration order.
 *
 * The desktop-web bundle stays passive: it only READS the registry; guests in
 * a plain browser have no registry and render nothing. Components receive the
 * standard slot props (slot, extensionId, rpc bridge).
 */

function compatHost(): MusePiCompatHost | null {
	return (globalThis as { MusePiCompatHost?: MusePiCompatHost }).MusePiCompatHost ?? null;
}

/** Render all extension components registered for a slot (extended mode).
 *  Memoized: the registry lookup allocates a fresh array per call — a
 *  re-render every snapshot frame would defeat the slot host. */
export const CompatSlotHost = memo(function CompatSlotHost({
	slot,
	className,
}: {
	slot: string;
	className?: string;
}): ReactNode {
	const host = compatHost();
	const items = host?.getForSlot(slot) ?? [];
	if (items.length === 0) return null;
	return (
		<div className={className} data-compat-slot={slot}>
			{items.map(({ Component, extensionId }, i) => (
				<div key={`${extensionId}:${i}`} data-compat-extension={extensionId}>
					{createElement(Component as ComponentType<Record<string, unknown>>, {
						slot,
						extensionId,
					})}
				</div>
			))}
		</div>
	);
});
