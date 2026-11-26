/**
 * InstanceManagerDialog — the two connection axes, in one place.
 *
 * The model this surface has to make legible, because the two halves are
 * routinely mistaken for each other:
 *
 *  - an **instance** chooses where the daemon runs — this machine, or a
 *    daemon reached over an ssh tunnel / WSL / a container / a typed
 *    endpoint;
 *  - a **workspace** chooses where the files live — a local path, or a remote
 *    path reached by mounting a host's filesystem.
 *
 * They are independent, so the three combinations a user actually meets are
 * all valid: local daemon + local files, daemon on a host + files on that
 * same host, and local daemon + files mounted from a host. Neither axis is
 * the other's mode, and this dialog must not present them as one.
 *
 * Hence two visible sections, not two tabs. A tab hides one axis behind a
 * click, which is exactly the shape that made the axes unreadable: the user
 * could only ever see half the model at a time. Each section states its axis
 * in one sentence and owns one primary action, so "which axis am I setting"
 * is answered before any row is read.
 *
 * The host catalog is read ONCE here and handed to the embedded wizard. The
 * manager used to render the wizard without a catalog, so the wizard silently
 * performed its own second read while the instance list beside it knew
 * nothing about the catalog at all — one dialog, two answers about which
 * hosts exist.
 */

import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { connectionPresentation } from "../lib/connection/presentation";
import type { CatalogHost } from "../lib/connection/remote-lifecycle";
import { type ConnectionTarget, stripToken } from "../lib/connection/targets";
import { useHostCatalog } from "../lib/connection/use-host-catalog";
import { buildWsUrl, type RemoteHost } from "../lib/remote-hosts";
import type { RpcClient } from "../lib/rpc";
import { Icon } from "../vendor/oc-icons";
import { ConnectionLocationRow } from "./ConnectionLocationRow";
import { ConnectionManager } from "./ConnectionManager";
import { DialogFrame } from "./DialogFrame";

/** Loopback endpoints are forwards, not locations: the daemon answers there,
 *  but it does not run there. */
function isLoopbackUrl(url: string): boolean {
	try {
		const host = new URL(url).hostname;
		return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
	} catch {
		return false;
	}
}

/** `host:port` for an endpoint that is itself the location. */
function endpointLocation(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/**
 * Where an instance's daemon runs, in one phrase.
 *
 * Never guessed: a catalog entry names the real machine, an endpoint that is
 * not loopback is its own location, and a loopback endpoint with no catalog
 * entry is honestly described as a forward rather than labelled with the
 * tunnel's local address (which is not where the daemon runs).
 */
function whereItRuns(host: RemoteHost | null, catalog: readonly CatalogHost[], daemonUrl: string): string {
	// The local row's name already says 本机, so repeating it as the location
	// would be a restatement. For the local daemon the loopback endpoint IS the
	// location, so it is the honest second fact on that row.
	if (!host) return endpointLocation(stripToken(daemonUrl));
	const entry = catalog.find(row => row.name === host.label);
	if (entry) {
		const destination = entry.username ? `${entry.username}@${entry.host}` : entry.host;
		return t("settings.connectionWhereSsh", { host: destination });
	}
	if (isLoopbackUrl(host.url)) return t("settings.connectionWhereForwarded");
	return endpointLocation(stripToken(host.url));
}

export function InstanceManagerDialog({
	open,
	onClose,
	rpc,
	connected,
	daemonUrl,
	hosts,
	onSwitchHost,
	onAddTarget,
	onRemoveHost,
	onDisconnect,
	onOpenDisclaimer,
}: {
	open: boolean;
	onClose(): void;
	rpc: RpcClient | null;
	connected: boolean;
	daemonUrl: string;
	hosts: RemoteHost[];
	onSwitchHost(host: RemoteHost | null): void;
	/** Adds the target the shared form built; `hosts` is derived from it, so
	 *  the row appears in this list without a second write. */
	onAddTarget(target: ConnectionTarget): void;
	onRemoveHost(id: string): void;
	onDisconnect(): void;
	onOpenDisclaimer(): void;
}): ReactNode {
	const { catalog, refresh } = useHostCatalog();
	const [formOpen, setFormOpen] = useState(false);
	/** Wizard step, reported by the embedded wizard: advancing it changes the
	 *  dialog's height, so the frame springs instead of snapping. */
	useEffect(() => {
		if (!open) return;
		setFormOpen(false);
		// The files can change under a long-lived window; opening is the moment
		// the user expects the list to be current. `refresh` is a dependency
		// because the hook guarantees its identity is stable (`useCallback` in
		// `use-host-catalog.ts`, guarded by `test/use-host-catalog-identity`).
		refresh();
	}, [open, refresh]);

	const activeHostId = useMemo(
		() => hosts.find(host => buildWsUrl(host) === daemonUrl)?.id ?? null,
		[hosts, daemonUrl],
	);

	/**
	 * One row per instance, through the shared primitive.
	 *
	 * The status word is what makes the trailing slot meaningful on every row:
	 * the current row says 当前 / 已断开, and a stored row says whether a probe
	 * has reached it. The old shape put a chip on the current row only, so half
	 * the list had no trailing slot and the two axes did not line up.
	 */
	const renderHost = (host: RemoteHost | null): ReactNode => {
		const active = host ? host.id === activeHostId : activeHostId === null;
		const label = host?.label ?? t("general.local");
		// One mapping for every surface (see `lib/connection/presentation`): the
		// row does not decide what "disconnected" means, it renders the phase.
		const presentation = connectionPresentation({ connected: active && connected });
		const status = t(presentation.labelKey);
		return (
			<ConnectionLocationRow
				key={host?.id ?? "local"}
				leading="dot"
				name={label}
				where={whereItRuns(host, catalog, daemonUrl)}
				whereTitle={host ? stripToken(host.url) : daemonUrl}
				status={status}
				statusKind={
					presentation.phase === "connected"
						? "connected"
						: presentation.phase === "idle"
							? "idle"
							: "disconnected"
				}
				current={active}
				disabled={active}
				onActivate={() => {
					if (active) return;
					onSwitchHost(host);
					onClose();
				}}
				action={
					host ? (
						<button
							type="button"
							className="gui-tool-btn gui-loc-remove"
							title={t("general.remove")}
							aria-label={t("general.remove")}
							onClick={() => onRemoveHost(host.id)}
						>
							<Icon name="delete-bin" className="h-3.5 w-3.5" />
						</button>
					) : undefined
				}
			/>
		);
	};

	return (
		<DialogFrame
			open={open}
			onClose={onClose}
			label={t("settings.connectionLocations")}
			className="gui-dialog--instance-manager"
			morphKey={`${formOpen}`}
		>
			<div className="gui-dialog-head">
				<span className="text-[15px] font-semibold">{t("settings.connectionLocations")}</span>
				<button type="button" className="gui-tool-btn" onClick={onClose} aria-label={t("settings.close")}>
					<Icon name="close" className="h-4 w-4" />
				</button>
			</div>

			{/* One sentence about the one axis this dialog owns. Where a project's
			 * files live is chosen when the project is added (添加项目), so
			 * repeating a workspace picker here made two answers for one
			 * question. */}
			<p className="gui-loc-purpose">{t("settings.instanceAxisHint")}</p>

			<div className="gui-instance-manager-body">
				<section className="gui-loc-section" aria-labelledby="gui-loc-instances">
					{/* The dialog head already names the surface, so the section title
					 * is read by assistive tech and painted for nobody: a landmark
					 * that points at nothing is the a11y regression this replaces. */}
					<h2 className="sr-only" id="gui-loc-instances">
						{t("settings.instanceAxisTitle")}
					</h2>
					<ul className="gui-loc-list">
						{renderHost(null)}
						{hosts.map(renderHost)}
					</ul>

					{hosts.length === 0 && <p className="gui-loc-empty">{t("settings.instanceListEmpty")}</p>}

					{/* One primary action per section: the form is what that action
					 * opens, not a third block competing with the list. Permanently
					 * open it made the section tall enough to push the other axis
					 * below the fold at the narrowest supported width. */}
					{!formOpen ? (
						<button
							type="button"
							className="gui-btn gui-btn-primary gui-loc-add"
							onClick={() => setFormOpen(true)}
						>
							<Icon name="add" className="h-3.5 w-3.5" />
							{t("settings.addInstance")}
						</button>
					) : (
						<ConnectionManager
							formOnly
							embedded
							state={connected ? "connected" : "disconnected-by-user"}
							catalog={catalog}
							onConnect={() => {}}
							onAdd={target => {
								onAddTarget(target);
								setFormOpen(false);
							}}
							onRemove={() => {}}
							onCopy={() => {}}
						/>
					)}
				</section>
			</div>

			{/* Dialog-level actions: they are about the connection itself, not
			 * about either axis, so they sit in the footer rather than competing
			 * with a section's one primary action. */}
			<footer className="gui-loc-foot">
				<button
					type="button"
					className="gui-btn gui-btn-stop"
					onClick={() => {
						onDisconnect();
						onClose();
					}}
				>
					{t("settings.disconnectCurrent")}
				</button>
				<button type="button" className="gui-remote-disclaimer-link" onClick={onOpenDisclaimer}>
					{t("settings.viewRemoteDisclaimer")}
				</button>
			</footer>
		</DialogFrame>
	);
}
