import { type MarketplaceCardAction, type MarketplaceCardEntry, MarketplaceGrid, t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { openExternalUrl } from "../lib/electron";
import type { RpcClient } from "../lib/rpc";
import { DialogFrame } from "./DialogFrame";

/**
 * Marketplace browse panel shared by the 扩展控制中心 (`ExtensionsCenter`)
 * and the capability center's 市场 tab (`CapabilityCenterPage`) — one
 * implementation so the two surfaces cannot drift. Wraps the shared
 * {@link MarketplaceGrid} from `@musepi/client-core` and routes install /
 * remove to the daemon `marketplace.install` / `marketplace.remove` RPCs.
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

	const handleAction = async (action: MarketplaceCardAction): Promise<void> => {
		if (!rpc) return;
		if (action.kind === "open") {
			setDetail(action.entry);
			return;
		}
		const method = action.kind === "install" ? "marketplace.install" : "marketplace.remove";
		await rpc.request(method, {
			name: action.entry.name,
			marketplace: action.entry.marketplace ?? "default",
		});
	};

	// MarketplaceGrid's `client` prop is duck-typed `{ rpc<T>(method, params?) }`;
	// RpcClient.request matches that signature, so a thin adapter is enough.
	const client = rpc ? { rpc: <T,>(m: string, p?: unknown): Promise<T> => rpc.request<T>(m, p) } : null;

	return (
		<div className="gui-ext-marketplace">
			<MarketplaceGrid client={client} onAction={handleAction} />
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
								{t("plugin detail homepage")}
							</button>
						)}
						{repository && (
							<button type="button" className="gui-btn" onClick={() => void openExternalUrl(repository)}>
								{t("plugin detail repository")}
							</button>
						)}
						<button type="button" className="gui-btn" onClick={onClose}>
							{t("close")}
						</button>
					</div>
				</div>
			)}
		</DialogFrame>
	);
}
