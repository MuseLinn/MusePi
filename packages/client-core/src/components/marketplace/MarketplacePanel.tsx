import { t } from "@musepi/client-locale/client";
import type { MarketplaceCardAction, MarketplaceGridProps } from "@musepi/client-ui-plugin-market/client";
import { MarketplaceGrid as Grid } from "@musepi/client-ui-plugin-market/client";
import type { ReactNode } from "react";
import { pushActionToast } from "../../lib/action-toast";
import type { SessionClient } from "../../lib/client";

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
	initialEntries?: MarketplaceGridProps["entries"];
}

async function handleAction(client: SessionClient, action: MarketplaceCardAction): Promise<void> {
	if (action.kind === "open") {
		// Detail view is a future milestone; surface a local notice so the user
		// isn't left wondering why their click vanished. Neither host answers a
		// `notice` RPC — the old request rejected as an unknown method.
		pushActionToast({ kind: "info", message: `${action.entry.name} · ${t("settings.comingSoon")}` });
		return;
	}
	const marketplace = action.entry.marketplace ?? "default";
	if (action.kind === "upgrade") {
		await client.rpc("marketplace.upgrade", {
			pluginId: `${action.entry.name}@${marketplace}`,
			scope: action.entry.installedScope ?? undefined,
			...(action.targetVersion !== undefined
				? { targetVersion: action.targetVersion, expectedVersion: action.entry.version }
				: {}),
			...(action.entry.sourceChanged === true ? { replace: true } : {}),
		});
		return;
	}
	const method = action.kind === "install" ? "marketplace.install" : "marketplace.remove";
	// The catalog version the card rendered is the version the user approved;
	// the daemon refuses the install if the catalog moved since.
	await client.rpc(method, {
		name: action.entry.name,
		marketplace,
		...(action.kind === "install" ? { expectedVersion: action.entry.version } : {}),
	});
}

export function MarketplacePanel({ client, initialEntries }: MarketplacePanelProps): ReactNode {
	return <Grid client={client} entries={initialEntries} onAction={action => handleAction(client, action)} />;
}
