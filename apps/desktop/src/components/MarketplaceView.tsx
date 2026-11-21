import {
	loadMarketplaceDetailPreference,
	type MarketplaceCardAction,
	MarketplaceGrid,
	saveMarketplaceDetailPreference,
	t,
} from "@musepi/client-core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useConfirm } from "../lib/prompt-dialog";
import type { RpcClient } from "../lib/rpc";
import { morphSurfaceBack, morphSurfaceFrom } from "../lib/view-transition";
import { MarketplaceDetailDialog, type MarketplaceDetailEntry } from "./MarketplaceDetailDialog";

/** Browse, install and inspect marketplace plugins. The detail dialog reads
 * complete metadata through marketplace.detail; only its plugin id is persisted
 * in the renderer, while the daemon owns the persistent source clone. */
export function MarketplaceView({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [detail, setDetail] = useState<MarketplaceDetailEntry | null>(() => loadMarketplaceDetailPreference());
	const [detailError, setDetailError] = useState<string | null>(null);
	const [toggleBusy, setToggleBusy] = useState(false);
	const lastDetailRef = useRef<MarketplaceDetailEntry | null>(null);
	if (detail) lastDetailRef.current = detail;
	const shownDetail = detail ?? lastDetailRef.current;
	const { confirm } = useConfirm();

	useEffect(() => {
		saveMarketplaceDetailPreference(
			detail ? { name: detail.name, marketplace: detail.marketplace ?? "default" } : null,
		);
	}, [detail]);

	useEffect(() => {
		if (!rpc || !detail) return;
		let active = true;
		setDetailError(null);
		void rpc
			.request("marketplace.detail", { name: detail.name, marketplace: detail.marketplace ?? "default" })
			.then(result => {
				if (active) setDetail(result as MarketplaceDetailEntry);
			})
			.catch((error: unknown) => {
				if (active) setDetailError(error instanceof Error ? error.message : String(error));
			});
		return () => {
			active = false;
		};
	}, [rpc, detail?.name, detail?.marketplace]);

	/** The card the detail dialog grew out of, for the reverse move on close. */
	const detailOrigin = useRef<HTMLElement | null>(null);

	const closeDetail = (): void => {
		morphSurfaceBack(
			document.querySelector(".gui-marketplace-detail"),
			detailOrigin.current,
			"marketplace-detail",
			() => setDetail(null),
		);
	};

	const handleAction = async (action: MarketplaceCardAction): Promise<void> => {
		if (!rpc) return;
		if (action.kind === "open") {
			const card =
				[...document.querySelectorAll<HTMLElement>("[data-marketplace-card]")].find(
					el => el.dataset.marketplaceCard === action.entry.name,
				) ?? null;
			detailOrigin.current = card;
			morphSurfaceFrom(card, "marketplace-detail", () => setDetail(action.entry));
			return;
		}
		const name = action.entry.name;
		const marketplace = action.entry.marketplace ?? "default";

		if (action.kind === "install") {
			const version = action.entry.version;
			const ok = await confirm(
				version !== undefined && version.length > 0
					? t("guest.marketplaceInstallConfirmWithVersion", { name, version, source: marketplace })
					: t("guest.marketplaceInstallConfirm", { name, source: marketplace }),
				t("guest.pluginInstall"),
			);
			if (!ok) return;
			await rpc.request("marketplace.install", { name, marketplace, expectedVersion: version });
			if (detail?.name === name && detail.marketplace === marketplace) {
				setDetail(current =>
					current ? { ...current, installed: true, enabled: true, installedVersion: version } : current,
				);
			}
			return;
		}

		if (action.kind === "remove") {
			const version = action.entry.installedVersion;
			const ok = await confirm(
				version !== undefined && version.length > 0
					? t("guest.marketplaceRemoveConfirmWithVersion", { name, version, source: marketplace })
					: t("guest.marketplaceRemoveConfirm", { name, source: marketplace }),
				t("guest.pluginRemove"),
				{ destructive: true },
			);
			if (!ok) return;
			await rpc.request("marketplace.remove", {
				name,
				marketplace,
				scope: action.entry.installedScope ?? undefined,
			});
			if (detail?.name === name && detail.marketplace === marketplace) {
				setDetail(current =>
					current ? { ...current, installed: false, enabled: undefined, installedVersion: undefined } : current,
				);
			}
			return;
		}

		const ok = await confirm(
			action.entry.sourceChanged === true
				? t("marketplace.replaceConfirm", {
						name,
						// The marketplace name is already part of the plugin ID, so
						// only the resolved repository says what changed.
						source: action.entry.source ?? marketplace,
						version: action.targetVersion ?? action.entry.version ?? "?",
					})
				: t("guest.marketplaceUpgradeConfirm", {
						name,
						from: action.entry.installedVersion ?? "?",
						to: action.targetVersion ?? action.entry.version ?? "?",
						source: marketplace,
					}),
			t("guest.pluginUpgrade"),
		);
		if (!ok) return;
		await rpc.request("marketplace.upgrade", {
			pluginId: `${name}@${marketplace}`,
			scope: action.entry.installedScope ?? undefined,
			// Version choice and the drift guard travel together: the user picked
			// a specific version, so a catalog that moved must not be installed.
			...(action.targetVersion !== undefined
				? { targetVersion: action.targetVersion, expectedVersion: action.entry.version }
				: {}),
			// Only sent when the source itself changed, i.e. after the user
			// confirmed replacing the plugin rather than updating it.
			...(action.entry.sourceChanged === true ? { replace: true } : {}),
		});
		if (detail?.name === name && detail.marketplace === marketplace) {
			const nextVersion = action.targetVersion ?? action.entry.version;
			setDetail(current =>
				current ? { ...current, installedVersion: nextVersion, updateAvailable: false } : current,
			);
		}
	};

	const handleUpgradeAll = async (count: number): Promise<void> => {
		if (!rpc) return;
		const ok = await confirm(t("guest.marketplaceUpgradeAllConfirm", { count }), t("guest.pluginUpgrade"));
		if (!ok) return;
		await rpc.request("marketplace.upgrade", { all: true });
	};

	const handleToggleEnabled = async (enabled: boolean): Promise<void> => {
		if (!rpc || !detail) return;
		const previous = detail.enabled;
		setToggleBusy(true);
		setDetail(current => (current ? { ...current, enabled } : current));
		try {
			await rpc.request("plugins.setEnabled", { name: detail.name, enabled });
		} catch (error) {
			setDetail(current => (current ? { ...current, enabled: previous } : current));
			setDetailError(error instanceof Error ? error.message : String(error));
		} finally {
			setToggleBusy(false);
		}
	};

	const client = rpc ? { rpc: <T,>(m: string, p?: unknown): Promise<T> => rpc.request<T>(m, p) } : null;

	return (
		<div className="gui-ext-marketplace">
			<MarketplaceGrid client={client} onAction={handleAction} onUpgradeAll={handleUpgradeAll} />
			<MarketplaceDetailDialog
				open={detail !== null}
				entry={shownDetail}
				busy={toggleBusy}
				error={detailError}
				onClose={closeDetail}
				onAction={handleAction}
				onToggleEnabled={handleToggleEnabled}
			/>
		</div>
	);
}
