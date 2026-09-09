import type { ReactNode } from "react";
import type { SessionClient } from "../../lib/client";
import { MarketplaceGrid } from "./MarketplaceGrid";
import type { MarketplaceCardAction } from "./types";
import "./marketplace.css";

/**
 * Marketplace panel — guest-side plugin catalog browser. Wired through
 * `client.rpc("marketplace.list" | "marketplace.install" | "marketplace.remove")`
 * if the host exposes those handlers; otherwise the grid degrades to a
 * static listing driven by the `entries` prop (used in storybook / tests).
 *
 * The install/remove handlers set `entry.busy` on the matching entry for
 * the duration of the RPC and toggle `entry.installed` on success. This
 * keeps the card affordances consistent without dragging the host state
 * machine into the panel.
 */

export interface MarketplacePanelProps {
	client: SessionClient;
	/** Optional initial entries (storybook / tests / pre-fetched cache). */
	initialEntries?: Parameters<typeof MarketplaceGrid>[0]["entries"];
}

async function handleAction(client: SessionClient, action: MarketplaceCardAction): Promise<void> {
	if (action.kind === "open") {
		// Detail view is a future milestone; surface as a non-fatal notice so
		// the user isn't left wondering why their click vanished.
		await client.rpc("notice", { level: "info", message: `${action.entry.name}: details coming soon` });
		return;
	}
	const method = action.kind === "install" ? "marketplace.install" : "marketplace.remove";
	await client.rpc(method, { name: action.entry.name, marketplace: action.entry.marketplace ?? "default" });
}

export function MarketplacePanel({ client, initialEntries }: MarketplacePanelProps): ReactNode {
	return (
		<MarketplaceGrid client={client} entries={initialEntries} onAction={action => handleAction(client, action)} />
	);
}
