import { Pencil, Plus, Server, Trash2, X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../../i18n/index.js";
import { useBackLayer } from "../../lib/back-stack";
import type { ConnectionPhase } from "../../lib/client";
import {
	hostIdForLink,
	loadHosts,
	loadResolvedHosts,
	type ResolvedHost,
	removeHost,
	renameHost,
} from "../../lib/hosts";
import { isTopModal, useModalFocus } from "../../lib/modal-focus";

function phaseLabel(phase: ConnectionPhase): string {
	switch (phase) {
		case "live":
		case "workspace":
			return t("transcript.connected");
		case "reconnecting":
			return t("shell.reconnecting");
		case "ended":
			return t("settings.notConnected");
		default:
			return t("settings.connecting2");
	}
}

function pathLabel(host: ResolvedHost): string {
	switch (host.candidates[0]?.kind) {
		case "lan":
			return t("settings.hostPathLan");
		case "tunnel":
			return t("settings.hostPathTunnel");
		default:
			return t("settings.hostPathRelay");
	}
}

/** Unified saved-host manager. The same records feed the connect screen,
 *  startup restore and in-session switching; removing the active host also
 *  leaves its session instead of leaving a deleted connection on screen. */
export function HostManager({
	currentLink,
	phase,
	onSwitchTo,
	onLeave,
	open: controlledOpen,
	onOpenChange,
	hideTrigger = false,
}: {
	currentLink: string;
	phase: ConnectionPhase;
	onSwitchTo(link: string, name: string): void;
	onLeave(): void;
	open?: boolean;
	onOpenChange?(open: boolean): void;
	hideTrigger?: boolean;
}): ReactNode {
	const [internalOpen, setInternalOpen] = useState(false);
	const open = controlledOpen ?? internalOpen;
	const setOpen = useCallback(
		(next: boolean | ((current: boolean) => boolean)): void => {
			const value = typeof next === "function" ? next(open) : next;
			if (controlledOpen === undefined) setInternalOpen(value);
			onOpenChange?.(value);
		},
		[controlledOpen, onOpenChange, open],
	);
	const [stage, setStage] = useState<"hidden" | "open" | "closing">("hidden");
	const [hosts, setHosts] = useState<ResolvedHost[] | null>(null);
	const [editing, setEditing] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [removing, setRemoving] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const dialogRef = useModalFocus<HTMLDivElement>(stage !== "hidden");
	const currentId = currentLink ? hostIdForLink(currentLink) : null;
	const currentHost = loadHosts().find(host => host.id === currentId);

	useEffect(() => {
		setStage(previous => (open ? "open" : previous === "open" ? "closing" : "hidden"));
	}, [open]);
	useEffect(() => {
		if (stage !== "closing") return;
		const timer = setTimeout(() => setStage("hidden"), 280);
		return () => clearTimeout(timer);
	}, [stage]);

	useEffect(() => {
		if (!open) return;
		let alive = true;
		setEditing(null);
		setHosts(null);
		void loadResolvedHosts().then(next => {
			if (alive) setHosts(next);
		});
		return () => {
			alive = false;
		};
	}, [open]);
	useEffect(() => {
		if (editing) inputRef.current?.focus();
	}, [editing]);

	const close = useCallback((): void => setOpen(false), [setOpen]);
	useBackLayer(
		85,
		open,
		useCallback(() => {
			close();
			return true;
		}, [close]),
	);
	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent): void => {
			const dialog = dialogRef.current;
			if (event.key !== "Escape" || !dialog || !isTopModal(dialog)) return;
			event.preventDefault();
			event.stopPropagation();
			if (editing) setEditing(null);
			else close();
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [open, editing, close, dialogRef]);

	const commitRename = (host: ResolvedHost): void => {
		renameHost(host.id, draft);
		setHosts(
			current =>
				current?.map(item => (item.id === host.id ? { ...item, label: draft.trim() || item.label } : item)) ?? null,
		);
		setEditing(null);
	};
	const submitRename = (event: FormEvent<HTMLFormElement>, host: ResolvedHost): void => {
		event.preventDefault();
		commitRename(host);
	};
	const remove = async (host: ResolvedHost): Promise<void> => {
		setRemoving(host.id);
		try {
			await removeHost(host.id);
			setHosts(current => current?.filter(item => item.id !== host.id) ?? null);
			if (host.id === currentId) {
				close();
				onLeave();
			}
		} finally {
			setRemoving(null);
		}
	};

	return (
		<div className="sh-switcher sh-host-switcher">
			{!hideTrigger && (
				<button
					type="button"
					className={open ? "sh-host-chip sh-host-chip--open" : "sh-host-chip"}
					onClick={() => setOpen(value => !value)}
					title={t("settings.manageHosts")}
					aria-expanded={open}
				>
					<Server size={14} />
					<span className="sh-host-chip-label">{currentHost?.label ?? t("settings.remoteHost")}</span>
					<span className={`sh-dot sh-dot-${phase}`} aria-hidden="true" />
				</button>
			)}
			{stage !== "hidden" &&
				createPortal(
					<div
						className={`ss-backdrop sh-host-manager-backdrop${stage === "closing" ? " ss-closing" : ""}`}
						onClick={close}
					>
						<div
							ref={dialogRef}
							className={`ss-card sh-host-manager${stage === "closing" ? " ss-closing" : ""}`}
							role="dialog"
							aria-modal="true"
							aria-label={t("settings.manageHosts")}
							onClick={event => event.stopPropagation()}
							onAnimationEnd={() => {
								if (stage === "closing") setStage("hidden");
							}}
						>
							<div className="ss-card-head">
								<div>
									<h2 className="ss-card-title">{t("settings.savedHosts")}</h2>
									{currentHost && <p className="sh-host-manager-status">{phaseLabel(phase)}</p>}
								</div>
								<div className="sh-host-manager-head-actions">
									<button
										type="button"
										className="sh-btn sh-btn-icon"
										title={t("settings.addHost")}
										onClick={() => {
											close();
											onLeave();
										}}
									>
										<Plus size={16} />
									</button>
									<button
										type="button"
										className="sh-btn sh-btn-icon"
										title={t("settings.close")}
										onClick={close}
									>
										<X size={16} />
									</button>
								</div>
							</div>
							<div className="sh-host-manager-list">
								{hosts === null && <div className="sh-switcher-empty">{t("settings.savedHostsLoading")}</div>}
								{hosts?.length === 0 && (
									<div className="sh-switcher-empty">{t("settings.noSavedHostsYet")}</div>
								)}
								{hosts?.map(host => {
									const isCurrent = host.id === currentId;
									return (
										<div
											key={host.id}
											className={
												isCurrent
													? "sh-switcher-item sh-host-manager-item sh-switcher-item--cur"
													: "sh-switcher-item sh-host-manager-item"
											}
										>
											{editing === host.id ? (
												<form
													className="sh-host-manager-edit"
													onSubmit={event => submitRename(event, host)}
												>
													<input
														ref={inputRef}
														className="sh-input"
														value={draft}
														onChange={event => setDraft(event.target.value)}
														onBlur={() => commitRename(host)}
														maxLength={40}
														aria-label={t("settings.hostName")}
													/>
												</form>
											) : (
												<button
													type="button"
													className="sh-switcher-main"
													disabled={isCurrent}
													onClick={() => {
														close();
														onSwitchTo(host.link, host.deviceName);
													}}
												>
													<span className="sh-switcher-label">{host.label}</span>
													<span className="sh-switcher-host">{host.candidates[0]?.address}</span>
												</button>
											)}
											<span className="sh-host-path">{pathLabel(host)}</span>
											{isCurrent && <span className="sh-switcher-cur-chip">{t("settings.current")}</span>}
											<button
												type="button"
												className="sh-btn sh-btn-icon sh-switcher-act sh-host-rename"
												title={t("settings.rename")}
												onClick={() => {
													setDraft(host.label);
													setEditing(host.id);
												}}
											>
												<Pencil size={13} />
											</button>
											<button
												type="button"
												className="sh-btn sh-btn-icon sh-switcher-act sh-host-remove"
												title={t("settings.removeHost")}
												disabled={removing === host.id}
												onClick={() => void remove(host)}
											>
												<Trash2 size={13} />
											</button>
										</div>
									);
								})}
							</div>
						</div>
					</div>,
					document.body,
				)}
		</div>
	);
}
