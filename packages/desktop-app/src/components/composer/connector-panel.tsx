import { type ReactNode, useCallback, useEffect, useState } from "react";
import { t } from "../../i18n/index.js";
import type { RpcClient } from "../../lib/rpc";
import { Icon } from "../../vendor/oc-icons";

/**
 * Connector picker — M4 P1 连接器面的客户端（对应 dsh M4 §4.3 的 composer chip）。
 *
 * The daemon already decides which servers this session may use: `connectors.list`
 * returns the live session's MCP servers with their real health, plus the
 * session's current selection. A selection of `null` is the semantic that matters
 * most here and is not the same as an empty one — null means the person never
 * chose, so every configured server is in play; an empty array means they chose
 * none. Collapsing the two would either hide servers that are running or offer
 * to "select all" a set that was deliberately narrowed.
 *
 * Health comes from the connection manager rather than from configuration. A
 * server configured but not connected is shown as such, because a picker that
 * says "connected" from the presence of a config entry reports something that is
 * not true.
 */

interface ConnectorServer {
	readonly name: string;
	readonly transport: "stdio" | "http" | "sse";
	readonly status: "connected" | "connecting" | "disconnected";
}

interface ConnectorSnapshot {
	readonly servers: readonly ConnectorServer[];
	/** null = never configured (all servers in play); array = an explicit choice. */
	readonly selected: readonly string[] | null;
}

/** What a row's checkbox means right now. */
function isChecked(snapshot: ConnectorSnapshot, name: string): boolean {
	// An unset selection is every server, so a row reads as checked before
	// anyone has touched anything — which is what is actually true of the tools
	// in this session.
	return snapshot.selected === null || snapshot.selected.includes(name);
}

/**
 * Load the selection for a session.
 *
 * Failure is reported as an empty list rather than a thrown error: the picker is
 * a chip above the input, and a session that cannot be asked must not take the
 * composer down with it.
 */
export function useConnectors(rpc: RpcClient | null, sessionId: string | null) {
	const [snapshot, setSnapshot] = useState<ConnectorSnapshot | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);

	const reload = useCallback(() => {
		if (!rpc || !sessionId) return;
		rpc.request<ConnectorSnapshot>("connectors.list", { sessionId })
			.then(next => {
				setSnapshot(next);
				setLoadFailed(false);
			})
			.catch(() => setLoadFailed(true));
	}, [rpc, sessionId]);

	useEffect(() => {
		setSnapshot(null);
		setLoadFailed(false);
		reload();
	}, [reload]);

	/**
	 * Apply a choice.
	 *
	 * `null` clears the selection back to "everything", which is the only way a
	 * person who narrowed it gets the default back — an empty array would leave
	 * them with no tools and no way to say they wanted all of them.
	 */
	const setSelection = useCallback(
		(servers: string[] | null) => {
			if (!rpc || !sessionId) return;
			rpc.request<{ ok: true; appliedToLive: boolean }>("connectors.setSelected", { sessionId, servers })
				.then(() => reload())
				.catch(() => setLoadFailed(true));
		},
		[reload, rpc, sessionId],
	);

	return { snapshot, loadFailed, reload, setSelection };
}

export function ConnectorChip({
	open,
	onToggle,
	anchorRef,
	menu,
	serverCount,
	chosenCount,
}: {
	open: boolean;
	onToggle(): void;
	anchorRef(el: HTMLElement | null): void;
	menu: ReactNode;
	serverCount: number;
	/** Servers in play; equal to `serverCount` until a choice is narrowed. */
	chosenCount: number;
}): ReactNode {
	const narrowed = chosenCount !== serverCount;
	return (
		<>
			<button
				type="button"
				ref={anchorRef}
				className={`gui-connector-chip${open ? " gui-connector-chip--open" : ""}${
					narrowed ? " gui-connector-chip--narrowed" : ""
				}`}
				title={t("connectors chip title")}
				aria-expanded={open}
				onClick={onToggle}
			>
				<Icon name="plug" className="h-3 w-3" />
				<span className="gui-connector-chip-label">
					{narrowed
						? t("connectors chip narrowed", { chosen: String(chosenCount), total: String(serverCount) })
						: t("connectors chip")}
				</span>
			</button>
			{menu}
		</>
	);
}

/** The picker's body: one row per server, plus the two out-of-band choices. */
export function ConnectorPanel({
	snapshot,
	loadFailed,
	onToggleServer,
	onToggleServers,
	onSelectAll,
	onUseAll,
}: {
	snapshot: ConnectorSnapshot | null;
	loadFailed: boolean;
	onToggleServer(name: string): void;
	/** Write a whole selection at once — what "select all" needs. */
	onToggleServers(names: string[]): void;
	onSelectAll(): void;
	/** Return to the unset selection, which means every configured server. */
	onUseAll(): void;
}): ReactNode {
	if (loadFailed && snapshot === null) {
		return <div className="gui-connector-panel gui-connector-panel--empty">{t("connectors load failed")}</div>;
	}
	if (snapshot === null) {
		return <div className="gui-connector-panel gui-connector-panel--empty">{t("connectors loading")}</div>;
	}
	if (snapshot.servers.length === 0) {
		return <div className="gui-connector-panel gui-connector-panel--empty">{t("connectors none")}</div>;
	}

	const allChecked = snapshot.servers.every(server => isChecked(snapshot, server.name));
	/** Checked rows plus the ones to add, in the panel's own order. */
	const checkedNames = () => snapshot.servers.filter(server => isChecked(snapshot, server.name)).map(s => s.name);

	return (
		<div className="gui-connector-panel" role="group" aria-label={t("connectors panel title")}>
			<div className="gui-connector-panel-head">
				<button
					type="button"
					className="gui-connector-link"
					onClick={() => (allChecked ? onSelectAll() : onToggleServers(checkedNames()))}
				>
					{allChecked ? t("connectors clear all") : t("connectors select all")}
				</button>
				{snapshot.selected !== null && (
					<button type="button" className="gui-connector-link" onClick={onUseAll}>
						{t("connectors use all")}
					</button>
				)}
			</div>
			<ul className="gui-connector-list">
				{snapshot.servers.map(server => (
					<li key={server.name}>
						<label className="gui-connector-row">
							<input
								type="checkbox"
								checked={isChecked(snapshot, server.name)}
								onChange={() => onToggleServer(server.name)}
							/>
							<span className="gui-connector-row-name">{server.name}</span>
							<span className="gui-connector-row-meta">
								{server.transport}
								<span
									className={`gui-connector-dot gui-connector-dot--${server.status}`}
									title={t(`connector status ${server.status}`)}
									aria-label={t(`connector status ${server.status}`)}
								/>
							</span>
						</label>
					</li>
				))}
			</ul>
		</div>
	);
}

/** Turn a toggle of one server into the selection to write. */
export function nextSelection(snapshot: ConnectorSnapshot, toggledName: string): string[] | null {
	const wasChecked = isChecked(snapshot, toggledName);
	const names = snapshot.servers.map(server => server.name);
	const next = wasChecked
		? names.filter(name => name !== toggledName)
		: // Start from the checked set rather than from the raw selection: an unset
			// selection means everything, so "checking one more" is a no-op that
			// becomes an explicit list of all of them.
			names.filter(name => (name !== toggledName ? isChecked(snapshot, name) : true));
	// Returning null when every server ends up in play keeps the panel in the
	// unset state instead of recording a selection identical to the default.
	return next.length === names.length ? null : next;
}
