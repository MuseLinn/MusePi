import { type MarketplaceCardAction, type MarketplaceCardEntry, MarketplaceGrid, t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { openExternalUrl } from "../lib/electron";
import { useConfirm } from "../lib/prompt-dialog";
import type { RpcClient } from "../lib/rpc";
import { DialogFrame } from "./DialogFrame";

/**
 * Marketplace browse panel shared by the 扩展控制中心 (`ExtensionsCenter`)
 * and the capability center's 市场 tab (`CapabilityCenterPage`) — one
 * implementation so the two surfaces cannot drift. Wraps the shared
 * {@link MarketplaceGrid} from `@musepi/client-core` and routes install /
 * remove / upgrade to the daemon `marketplace.*` RPCs.
 *
 * Install, remove and upgrade are trust boundaries: each one confirms first
 * with the marketplace source and the version the user is approving. The
 * confirmed catalog version travels as `expectedVersion`, so a catalog that
 * moved between confirmation and install is rejected rather than silently
 * installed.
 *
 * "Open detail" shows a metadata dialog built from the catalog entry
 * itself (the daemon exposes no marketplace.detail RPC, so everything the
 * dialog shows is already on the card entry); homepage / repository open
 * through the system browser.
 */
export function MarketplaceView({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [detail, setDetail] = useState<MarketplaceCardEntry | null>(null);
	// Keep the last entry through the dialog's 180ms exit animation so the
	// content doesn't blank out while the frame is still closing.
	const lastDetailRef = useRef<MarketplaceCardEntry | null>(null);
	if (detail) lastDetailRef.current = detail;
	const shownDetail = detail ?? lastDetailRef.current;
	const { confirm } = useConfirm();

	const handleAction = async (action: MarketplaceCardAction): Promise<void> => {
		if (!rpc) return;
		if (action.kind === "open") {
			setDetail(action.entry);
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
			return;
		}

		const ok = await confirm(
			t("guest.marketplaceUpgradeConfirm", {
				name,
				from: action.entry.installedVersion ?? "?",
				to: action.entry.version ?? "?",
				source: marketplace,
			}),
			t("guest.pluginUpgrade"),
		);
		if (!ok) return;
		await rpc.request("marketplace.upgrade", {
			pluginId: `${name}@${marketplace}`,
			scope: action.entry.installedScope ?? undefined,
		});
	};

	// Bulk upgrade confirms once for the whole batch: per-card dialogs would
	// ask N times for one click.
	const handleUpgradeAll = async (count: number): Promise<void> => {
		if (!rpc) return;
		const ok = await confirm(t("guest.marketplaceUpgradeAllConfirm", { count }), t("guest.pluginUpgrade"));
		if (!ok) return;
		await rpc.request("marketplace.upgrade", { all: true });
	};

	// MarketplaceGrid's `client` prop is duck-typed `{ rpc<T>(method, params?) }`;
	// RpcClient.request matches that signature, so a thin adapter is enough.
	const client = rpc ? { rpc: <T,>(m: string, p?: unknown): Promise<T> => rpc.request<T>(m, p) } : null;

	return (
		<div className="gui-ext-marketplace">
			<MarketplaceGrid client={client} onAction={handleAction} onUpgradeAll={handleUpgradeAll} />
			<MarketplaceDetailDialog open={detail !== null} entry={shownDetail} onClose={() => setDetail(null)} />
		</div>
	);
}

/** Metadata dialog for one catalog entry. Always mounted (driven by `open`)
 *  so the DialogFrame exit animation plays; `entry` stays non-null through
 *  the exit via the parent's ref. */
function MarketplaceDetailDialog({
	open,
	entry,
	onClose,
}: {
	open: boolean;
	entry: MarketplaceCardEntry | null;
	onClose(): void;
}): ReactNode {
	const meta: string[] = [];
	if (entry?.author) meta.push(`by ${entry.author}`);
	if (entry?.version) meta.push(`v${entry.version}`);
	if (typeof entry?.installs === "number") meta.push(`↓ ${entry.installs.toLocaleString("en-US")}`);
	if (entry?.marketplace) meta.push(entry.marketplace);
	const chips = [entry?.category ?? "", ...(entry?.tags ?? [])].filter(Boolean);
	const homepage = entry?.homepage;
	const repository = entry?.repository;
	return (
		<DialogFrame open={open} onClose={onClose} label={entry?.name ?? ""} className="gui-dialog--confirm">
			{entry && (
				<div>
					<h3>{entry.name}</h3>
					{entry.description && <p>{entry.description}</p>}
					{meta.length > 0 && <p>{meta.join(" · ")}</p>}
					{chips.length > 0 && <p>{chips.join(" · ")}</p>}
					{entry.license && <p>{entry.license}</p>}
					<div className="gui-cron-form-actions">
						{homepage && (
							<button type="button" className="gui-btn" onClick={() => void openExternalUrl(homepage)}>
								{t("guest.pluginDetailHomepage")}
							</button>
						)}
						{repository && (
							<button type="button" className="gui-btn" onClick={() => void openExternalUrl(repository)}>
								{t("guest.pluginDetailRepository")}
							</button>
						)}
						<button type="button" className="gui-btn" onClick={onClose}>
							{t("settings.close")}
						</button>
					</div>
				</div>
			)}
		</DialogFrame>
	);
}
