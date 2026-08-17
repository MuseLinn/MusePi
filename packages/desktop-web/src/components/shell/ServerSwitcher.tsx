import { Pencil, Server, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import { loadConnections, removeConnection, renameConnection } from "../../lib/connections";

/**
 * Multi-server switcher (openchamber "Instances" parity): lists every saved
 * connection, lets the guest jump to another computer's daemon, relabel, or
 * delete an entry. The list is re-read each time the popover opens, so edits
 * made in the connect screen show up here immediately.
 */
export function ServerSwitcher({
	currentLink,
	onSwitchTo,
}: {
	currentLink: string;
	onSwitchTo(link: string, name: string): void;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const [editing, setEditing] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const inputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		if (open) setEditing(null);
	}, [open]);
	useEffect(() => {
		if (editing) inputRef.current?.focus();
	}, [editing]);

	const connections = open ? loadConnections() : [];

	return (
		<div className="sh-switcher">
			<button
				type="button"
				className={open ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
				onClick={() => setOpen(!open)}
				title={t("switch connection")}
			>
				<Server size={14} />
			</button>
			{open && (
				<>
					<div className="sh-switcher-overlay" onClick={() => setOpen(false)} />
					<div className="sh-switcher-pop" role="menu">
						<div className="sh-switcher-title">{t("saved connections")}</div>
						{connections.length === 0 && (
							<div className="sh-switcher-empty">{t("no saved connections yet — connect once to save one")}</div>
						)}
						{connections.map(c => {
							const isCurrent = c.link === currentLink;
							return (
								<div
									key={c.link}
									className={isCurrent ? "sh-switcher-item sh-switcher-item--cur" : "sh-switcher-item"}
									role="menuitem"
								>
									<button
										type="button"
										className="sh-switcher-main"
										onClick={() => {
											if (isCurrent) return;
											setOpen(false);
											onSwitchTo(c.link, c.name);
										}}
									>
										{editing === c.link ? (
											<input
												ref={inputRef}
												className="sh-input sh-input-mono"
												value={draft}
												onChange={e => setDraft(e.target.value)}
												onKeyDown={e => {
													if (e.key === "Enter") {
														renameConnection(c.link, draft.trim());
														setEditing(null);
														setOpen(true);
													} else if (e.key === "Escape") {
														setEditing(null);
													}
												}}
												onBlur={() => setEditing(null)}
												onClick={e => e.stopPropagation()}
												spellCheck={false}
												maxLength={40}
											/>
										) : (
											<>
												<span className="sh-switcher-label">{c.label || c.name}</span>
												<span className="sh-switcher-host">{c.link}</span>
											</>
										)}
									</button>
									{isCurrent && <span className="sh-switcher-cur-chip">{t("current")}</span>}
									<button
										type="button"
										className="sh-btn sh-btn-icon sh-switcher-act"
										title={t("rename")}
										onClick={() => {
											if (editing === c.link) return;
											setDraft(c.label || c.name);
											setEditing(c.link);
										}}
									>
										<Pencil size={12} />
									</button>
									<button
										type="button"
										className="sh-btn sh-btn-icon sh-switcher-act"
										title={t("remove")}
										onClick={() => {
											removeConnection(c.link);
											setOpen(true);
										}}
									>
										<X size={12} />
									</button>
								</div>
							);
						})}
					</div>
				</>
			)}
		</div>
	);
}
