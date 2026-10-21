import { type TranslationKey, t } from "@musepi/client-core";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { RpcClient } from "../../lib/rpc";
import { Icon } from "../../vendor/oc-icons";

/**
 * Connector picker — M4 P1 连接器面的客户端（composer 上的连接器 chip）。
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

/** Connector status labels are keyed per status id (closed set). */
export const CONNECTOR_STATUS_KEY: Record<string, TranslationKey> = {
	connected: "tools.connectorStatusConnected",
	connecting: "tools.connectorStatusConnecting",
	disconnected: "tools.connectorStatusDisconnected",
};

export interface ConnectorSnapshot {
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
 *
 * 两种问法（GUI 的两种宿主共用）：
 * - live 会话：`sessionId`（composer chip 的原生场景）。
 * - 空态输入框/欢迎页：draft 没有 sessionId（startNewTask 把 store 清空，
 *   会话在首条消息发送时才创建），只给 `cwd`——daemon 按 cwd 回退出
 *   服务器清单 + 健康态，选择态为 null。
 *
 * 空态下的勾选没有会话头可写：选择以 cwd 为键暂存（pending），乐观
 * 反映到当前快照；会话 id 一旦出现（首条消息发送、会话创建完成），
 * pending 值原样写回 `connectors.setSelected` 并清掉暂存。
 */
export function useConnectors(rpc: RpcClient | null, sessionId: string | null, cwd?: string | null) {
	const [snapshot, setSnapshot] = useState<ConnectorSnapshot | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);

	const reload = useCallback(() => {
		if (!rpc) return;
		const params = sessionId ? { sessionId, cwd } : cwd ? { cwd } : null;
		if (!params) return;
		rpc.request<ConnectorSnapshot>("connectors.list", params)
			.then(next => {
				setSnapshot(next);
				setLoadFailed(false);
			})
			.catch(() => setLoadFailed(true));
	}, [rpc, sessionId, cwd]);

	useEffect(() => {
		setSnapshot(null);
		setLoadFailed(false);
		reload();
	}, [reload]);

	// Draft → live 过渡：把空态攒下的选择写进新会话头。发生在会话创建
	// 之后（store.sessionId 置上），setSelected 即刻生效于 live 会话。
	useEffect(() => {
		if (!rpc || !sessionId) return;
		const pending = cwd ? readPendingSelection(cwd) : undefined;
		if (pending === undefined) return;
		rpc.request<{ ok: true; appliedToLive: boolean }>("connectors.setSelected", { sessionId, servers: pending })
			.then(() => {
				if (cwd) clearPendingSelection(cwd);
				reload();
			})
			.catch(() => {});
	}, [rpc, sessionId, cwd, reload]);

	/**
	 * Apply a choice.
	 *
	 * `null` clears the selection back to "everything", which is the only way a
	 * person who narrowed it gets the default back — an empty array would leave
	 * them with no tools and no way to say they wanted all of them.
	 */
	const setSelection = useCallback(
		(servers: string[] | null) => {
			if (!rpc) return;
			if (!sessionId) {
				// 空态：没有会话头可持久化。暂存意图（cwd 键），乐观更新
				// 当前快照；会话创建后由上面的 effect 采纳写回。
				if (cwd) writePendingSelection(cwd, servers);
				setSnapshot(prev => (prev ? { ...prev, selected: servers } : prev));
				return;
			}
			rpc.request<{ ok: true; appliedToLive: boolean }>("connectors.setSelected", { sessionId, servers })
				.then(() => reload())
				.catch(() => setLoadFailed(true));
		},
		[reload, rpc, sessionId, cwd],
	);

	return { snapshot, loadFailed, reload, setSelection };
}

/** 空态选择暂存的 localStorage 键：cwd → servers（null = 显式全量语义）。 */
const PENDING_KEY = "musepi-gui-connectors-pending";

type PendingMap = Record<string, string[] | null>;

function readPendingMap(): PendingMap {
	if (typeof localStorage === "undefined") return {};
	try {
		const raw = localStorage.getItem(PENDING_KEY);
		if (!raw) return {};
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as PendingMap;
	} catch {
		return {};
	}
}

/** 读某 cwd 的暂存选择：undefined = 没有暂存；null = 暂存了「全量」。 */
function readPendingSelection(cwd: string): string[] | null | undefined {
	return readPendingMap()[cwd];
}

function writePendingSelection(cwd: string, servers: string[] | null): void {
	if (typeof localStorage === "undefined") return;
	const map = readPendingMap();
	map[cwd] = servers;
	try {
		localStorage.setItem(PENDING_KEY, JSON.stringify(map));
	} catch {
		// 配额满时放弃暂存：空态选择丢失，会话内选择不受影响。
	}
}

function clearPendingSelection(cwd: string): void {
	if (typeof localStorage === "undefined") return;
	const map = readPendingMap();
	if (!(cwd in map)) return;
	delete map[cwd];
	try {
		localStorage.setItem(PENDING_KEY, JSON.stringify(map));
	} catch {
		// 同上。
	}
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
				title={t("tools.connectorsChipTitle")}
				aria-expanded={open}
				onClick={onToggle}
			>
				<Icon name="plug" className="h-3 w-3" />
				<span className="gui-connector-chip-label">
					{narrowed
						? t("tools.connectorsChipNarrowed", { chosen: String(chosenCount), total: String(serverCount) })
						: t("tools.connectorsChip")}
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
		return <div className="gui-connector-panel gui-connector-panel--empty">{t("tools.connectorsLoadFailed")}</div>;
	}
	if (snapshot === null) {
		return <div className="gui-connector-panel gui-connector-panel--empty">{t("tools.connectorsLoading")}</div>;
	}
	if (snapshot.servers.length === 0) {
		return <div className="gui-connector-panel gui-connector-panel--empty">{t("tools.connectorsNone")}</div>;
	}

	const allChecked = snapshot.servers.every(server => isChecked(snapshot, server.name));
	/** Checked rows plus the ones to add, in the panel's own order. */
	const checkedNames = () => snapshot.servers.filter(server => isChecked(snapshot, server.name)).map(s => s.name);

	return (
		<div className="gui-connector-panel" role="group" aria-label={t("tools.connectorsPanelTitle")}>
			<div className="gui-connector-panel-head">
				<span className="gui-connector-panel-title">
					{t("tools.connectorsPanelTitle")}
					<span className="gui-connector-panel-count">{snapshot.servers.length}</span>
				</span>
				<span className="gui-connector-panel-links">
					<button
						type="button"
						className="gui-connector-link"
						onClick={() => (allChecked ? onSelectAll() : onToggleServers(checkedNames()))}
					>
						{allChecked ? t("tools.connectorsClearAll") : t("tools.connectorsSelectAll")}
					</button>
					{snapshot.selected !== null && (
						<button type="button" className="gui-connector-link" onClick={onUseAll}>
							{t("tools.connectorsUseAll")}
						</button>
					)}
				</span>
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
									title={t(CONNECTOR_STATUS_KEY[server.status] ?? server.status)}
									aria-label={t(CONNECTOR_STATUS_KEY[server.status] ?? server.status)}
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
