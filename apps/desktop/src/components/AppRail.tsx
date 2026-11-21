import { punkAvatarUri, type TranslationKey, t } from "@musepi/client-core";
import { type MouseEvent as ReactMouseEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { type GitUser, readGitUser } from "../lib/git-user";
import { buildWsUrl, type RemoteHost } from "../lib/remote-hosts";
import type { RpcClient } from "../lib/rpc";
import { onUserAvatarChanged, readUserAvatarPrefs, type UserAvatarPrefs } from "../lib/user-avatar";
import { Icon } from "../vendor/oc-icons";
import type { IconName } from "../vendor/oc-icons/icons";
import { PunkAvatar } from "./avatar-presets";
import { MenuPopup } from "./MenuPopup";

/**
 * App rail — the persistent 52px destination column left of the panel.
 *
 * Two-tier shell (ChatGPT desktop parity): this column never leaves the
 * window, so every destination stays one click away while the panel slot
 * swaps content underneath it, and collapsing the panel cannot strand the
 * user because the way back never lives inside the collapsed layer.
 *
 * The rail is deliberately dumb: it takes prepared destinations and renders
 * them. Selection state lives in `app.tsx`, so the rail can never disagree
 * with the surface it drives. The one stateful piece is the account control
 * (`UserAccountButton`), whose trigger/menu state is local and whose actions
 * all belong to the host.
 *
 * Its width lives only in CSS (`--gui-rail-w`, `gui-chrome.css`): every
 * offset that depends on it — the sidebar splitter, the narrow-mode drawer —
 * reads that variable, so there is no second copy to drift.
 */

export interface RailItem {
	id: string;
	label: TranslationKey;
	icon: IconName;
	/** Destination currently shown (aria-current="page"). */
	active?: boolean;
	/** Unread activity dot — independent of `active` (a destination can hold
	 *  unread items while you are looking at a different one). */
	unread?: boolean;
	/** Id of the second-tier panel this destination owns. Only destinations
	 *  with a panel may float one on hover; the rail's empty band and action
	 *  buttons never peek (2026-11-08). */
	panelId?: string;
	onSelect(): void;
}

function RailButton({
	item,
	onPeekPanel,
	onPeekEnd,
}: {
	item: RailItem;
	onPeekPanel?: (panelId: string) => void;
	onPeekEnd?(): void;
}): ReactNode {
	const label = t(item.label);
	return (
		<button
			type="button"
			className={`gui-rail-btn${item.active ? " gui-rail-btn--active" : ""}`}
			title={label}
			aria-label={label}
			aria-current={item.active ? "page" : undefined}
			data-rail-destination={item.id}
			data-rail-panel={item.panelId}
			onClick={item.onSelect}
			onPointerEnter={item.panelId ? () => onPeekPanel?.(item.panelId as string) : undefined}
			onPointerLeave={item.panelId ? onPeekEnd : undefined}
		>
			<Icon name={item.icon} className="gui-rail-icon" />
			{item.unread ? <span className="gui-rail-dot" aria-hidden="true" /> : null}
		</button>
	);
}

/**
 * Git identity for the account control, resolved once per (rpc, cwd). The
 * picture and the menu header both read it, and `readGitUser` caches per cwd,
 * so the two consumers share one daemon read.
 */
function useGitUser(rpc: RpcClient | null, cwd: string): GitUser | null {
	const [user, setUser] = useState<GitUser | null>(null);
	useEffect(() => {
		if (!rpc) return;
		let cancelled = false;
		void readGitUser(rpc, cwd).then(u => {
			if (!cancelled) setUser(u);
		});
		return () => {
			cancelled = true;
		};
	}, [rpc, cwd]);
	return user;
}

/**
 * User picture — one of three sources (设置 → Git → 用户头像来源,
 * `lib/user-avatar.ts`): `auto` = GitHub avatar (`https://github.com/
 * <login>.png`) → the identity-derived pixel face → the initial chip;
 * `punk` = the user-chosen pixel face; `initial` = the letter chip only
 * (no network). The title carries the git name/email (falls back to the
 * generic user chip).
 *
 * Owned by the rail because the account control is the only place the
 * picture appears: the per-row user avatar is gone and the agent orb lives
 * in the chat capsule.
 */
function UserAvatar({ rpc, cwd }: { rpc: RpcClient | null; cwd: string }): ReactNode {
	const user = useGitUser(rpc, cwd);
	const [avatarFailed, setAvatarFailed] = useState(false);
	const [prefs, setPrefs] = useState<UserAvatarPrefs>(readUserAvatarPrefs);
	// The picture can change under a mounted avatar (login, logout, a new
	// GitHub account), so the source is state, not a render-time read:
	// without this the control kept the URL it first painted with.
	useEffect(() => {
		const sync = (): void => {
			const next = readUserAvatarPrefs();
			setPrefs(prev => (prev.mode === next.mode && prev.url === next.url ? prev : next));
		};
		return onUserAvatarChanged(sync);
	}, []);
	const { mode: avatarMode, url: avatarUrl } = prefs;
	// A new picture (or a retry after switching back) must clear the failure
	// latch; otherwise one broken URL pins the control to the fallback face
	// for the life of the window.
	useEffect(() => {
		setAvatarFailed(false);
	}, [avatarUrl, avatarMode]);
	const initial = user?.name?.trim().charAt(0)?.toLocaleUpperCase() ?? "";
	const title = user ? (user.email ? `${user.name} <${user.email}>` : user.name) : t("settings.you");
	const punkFace = user?.name?.trim() ? (
		<img src={punkAvatarUri(user.name.trim())} alt="" className="gui-user-avatar-img gui-avatar-punk" />
	) : null;
	const letterFace = initial ? <span className="gui-user-avatar-letter">{initial}</span> : null;
	return (
		<span className="gui-user-avatar" title={title}>
			{avatarMode === "initial" ? (
				(letterFace ?? <Icon name="user" className="h-3.5 w-3.5" />)
			) : avatarMode === "punk" ? (
				/* Explicit pixel-face mode: the user-chosen seed (设置 → 常规
				 * 换一个 / seed 输入, PUNK_SEED_KEY) — NOT the git-identity
				 * face, so the control follows the settings choice and never
				 * degrades to a blank icon when git identity is absent.
				 * PunkAvatar listens for omp-avatar-changed, so 换一个/apply
				 * re-renders every mounted avatar live. */
				<PunkAvatar size={20} />
			) : avatarUrl && !avatarFailed ? (
				<img src={avatarUrl} alt="" className="gui-user-avatar-img" onError={() => setAvatarFailed(true)} />
			) : (
				(punkFace ?? letterFace ?? <Icon name="user" className="h-3.5 w-3.5" />)
			)}
		</span>
	);
}

const LOCAL_DAEMON_URL = "ws://127.0.0.1:8300";

/**
 * Account control — the user picture that replaced the rail's settings gear.
 *
 * The gear was a single-purpose button for a menu of account/session actions,
 * so the picture now owns that slot and the menu behind it: Settings,
 * keyboard shortcuts, session sharing, workspace remote access, host
 * switching and disconnecting. Remote access keeps BOTH entrances the rail
 * and header owned — the session share needs an open session, so the
 * workspace (mobile/browser join) row could not be folded into it. The rail
 * keeps one permanent entry (the user), and the sidebar footer mounts the
 * same control, so a gear never has to be duplicated.
 *
 * Trigger state is self-managed; every action is the host's.
 */
export function UserAccountButton({
	rpc,
	cwd,
	hosts,
	daemonUrl,
	connected,
	onOpenSettings,
	onOpenShortcuts,
	onOpenCollab,
	onOpenRemoteAccess,
	onSwitchHost,
	onDisconnect,
	compact = true,
}: {
	rpc: RpcClient | null;
	/** Workspace the git identity is resolved from (the picture's source). */
	cwd: string;
	hosts: readonly RemoteHost[];
	daemonUrl: string;
	connected: boolean;
	onOpenSettings(): void;
	onOpenShortcuts?(): void;
	/** Share the CURRENT session (entries in the header/session menus). */
	onOpenCollab?(): void;
	/** Share the WORKSPACE (mobile/browser join QR) — the rail's old
	 *  remote-control entry, kept as its own row because the session share
	 *  needs an open session and cannot replace it. */
	onOpenRemoteAccess?(): void;
	onSwitchHost(host: RemoteHost | null): void;
	onDisconnect(): void;
	/** Rail geometry (36px square) vs the sidebar footer's inline control. */
	compact?: boolean;
}): ReactNode {
	const btnRef = useRef<HTMLButtonElement | null>(null);
	const [open, setOpen] = useState(false);
	const user = useGitUser(rpc, cwd);
	const label = t("general.accountMenu");
	const localActive = daemonUrl === LOCAL_DAEMON_URL;
	const close = (): void => setOpen(false);
	return (
		<div className="gui-account">
			<button
				type="button"
				ref={btnRef}
				className={compact ? "gui-rail-btn gui-account-btn" : "gui-account-btn gui-account-btn--footer"}
				title={label}
				aria-label={label}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen(v => !v)}
			>
				<UserAvatar rpc={rpc} cwd={cwd} />
				<span className={`gui-account-dot${connected ? " gui-account-dot--on" : ""}`} aria-hidden="true" />
			</button>
			<MenuPopup
				open={open}
				className="gui-account-menu"
				anchor={btnRef.current}
				align="left"
				onOpenChange={setOpen}
			>
				<div className="gui-account-head">
					<div className="gui-account-name">{user?.name || t("general.user")}</div>
					{user?.email ? <div className="gui-account-mail">{user.email}</div> : null}
				</div>
				<button
					type="button"
					className="gui-menu-item"
					onClick={() => {
						close();
						onOpenSettings();
					}}
				>
					<Icon name="settings-3" className="h-3.5 w-3.5" />
					<span>{t("settings.settings")}</span>
				</button>
				{onOpenShortcuts && (
					<button
						type="button"
						className="gui-menu-item"
						onClick={() => {
							close();
							onOpenShortcuts();
						}}
					>
						<Icon name="command" className="h-3.5 w-3.5" />
						<span>{t("general.keyboardShortcuts")}</span>
					</button>
				)}
				{onOpenCollab && (
					<button
						type="button"
						className="gui-menu-item"
						onClick={() => {
							close();
							onOpenCollab();
						}}
					>
						<Icon name="share-2" className="h-3.5 w-3.5" />
						<span>{t("settings.shareCurrentSession")}</span>
					</button>
				)}
				{/* Workspace sharing is its own entrance: the session share needs an
				 * open session, so folding remote control into that row would make
				 * mobile/browser joining unreachable on the welcome page. */}
				{onOpenRemoteAccess && (
					<button
						type="button"
						className="gui-menu-item"
						onClick={() => {
							close();
							onOpenRemoteAccess();
						}}
					>
						<Icon name="global" className="h-3.5 w-3.5" />
						<span>{t("settings.mobileRemoteControl")}</span>
					</button>
				)}
				<div className="gui-account-divider" />
				<div className="gui-account-section">{t("general.switchHost")}</div>
				<button
					type="button"
					className={`gui-account-host${localActive ? " gui-account-host--active" : ""}`}
					aria-current={localActive ? "true" : undefined}
					onClick={() => {
						close();
						if (!localActive) onSwitchHost(null);
					}}
				>
					<span
						className={`gui-account-host-dot${localActive && connected ? " gui-account-host-dot--on" : ""}`}
						aria-hidden="true"
					/>
					<span className="gui-account-host-label">{t("general.local")}</span>
					{localActive && <Icon name="check" className="h-3 w-3 ml-auto" />}
				</button>
				{hosts.map(host => {
					const active = buildWsUrl(host) === daemonUrl;
					return (
						<button
							key={host.id}
							type="button"
							className={`gui-account-host${active ? " gui-account-host--active" : ""}`}
							aria-current={active ? "true" : undefined}
							title={host.url}
							onClick={() => {
								close();
								if (!active) onSwitchHost(host);
							}}
						>
							<span className="gui-account-host-dot" aria-hidden="true" />
							<span className="gui-account-host-label">{host.label}</span>
							{active && <Icon name="check" className="h-3 w-3 ml-auto" />}
						</button>
					);
				})}
				<div className="gui-account-divider" />
				<button
					type="button"
					className={`gui-menu-item${connected ? "" : " gui-menu-item--disabled"}`}
					disabled={!connected}
					onClick={() => {
						close();
						onDisconnect();
					}}
				>
					<Icon name="close" className="h-3.5 w-3.5" />
					<span>{t("settings.disconnect")}</span>
				</button>
			</MenuPopup>
		</div>
	);
}

export function AppRail({
	destinations,
	account,
	footerActions,
	panelAvailable,
	onTogglePanel,
	onPeekPanel,
	onPeekEnd,
}: {
	destinations: readonly RailItem[];
	/** The persistent user/account entry that replaced the settings
	 *  destination button, and absorbed the shortcut / remote-control buttons
	 *  (the two remote-access scopes stay separate rows). Rendered last, so
	 *  the account owns the rail's bottom corner. */
	account?: ReactNode;
	/** Instance status that used to live only in the sidebar footer; the rest
	 *  of those entries moved into the account menu. Stays reachable when the
	 *  panel is folded or a page destination replaces it (ChatGPT's rail
	 *  footer parity). */
	footerActions?: ReactNode;
	/** The active destination owns a left panel (首页 / 任务中心). Page
	 *  destinations without one do not offer folding. */
	panelAvailable: boolean;
	onTogglePanel(): void;
	/** Hover-peek (2026-11-08): the gesture starts on ONE destination button
	 *  that owns a panel, never on the rail's empty band. The host decides which
	 *  panel floats from the reported `panelId`, so 任务中心 can peek its own
	 *  task list instead of the 首页 session list. */
	onPeekPanel?(panelId: string): void;
	onPeekEnd?(): void;
}): ReactNode {
	// The 48px top band is EMPTY by design: the window's own fold/unfold
	// control lives in the titlebar cluster at the panel's top edge. Rendering
	// a second one in the rail duplicated it and (on frameless windows) the
	// fixed-position cluster landed on top of it. The band only keeps
	// destinations below the header row and stays draggable.
	const onBackgroundDoubleClick = (event: ReactMouseEvent<HTMLElement>): void => {
		if (!panelAvailable) return;
		if (event.target instanceof Element && event.target.closest("button")) return;
		onTogglePanel();
	};
	return (
		<nav
			className="gui-rail"
			aria-label={t("general.appRail")}
			data-gui-scrollbar="off"
			onDoubleClick={onBackgroundDoubleClick}
		>
			<div className="gui-rail-top" aria-hidden="true" />
			<div className="gui-rail-scroll" data-gui-scrollbar="off">
				{destinations.map(item => (
					<RailButton key={item.id} item={item} onPeekPanel={onPeekPanel} onPeekEnd={onPeekEnd} />
				))}
			</div>
			<div className="gui-rail-group">
				{footerActions}
				{account}
			</div>
		</nav>
	);
}
