import { punkAvatarUri, type TranslationKey, t } from "@musepi/client-core";
import { type IconInput, MorphIcon } from "morphicons/react";
import { type MouseEvent as ReactMouseEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { type GitUser, readGitUser } from "../lib/git-user";
import type { RpcClient } from "../lib/rpc";
import { onUserAvatarChanged, readUserAvatarPrefs, type UserAvatarPrefs } from "../lib/user-avatar";
import { Icon } from "../vendor/oc-icons";
import type { IconName } from "../vendor/oc-icons/icons";
import { PunkAvatar } from "./avatar-presets";
import { BrandOrb } from "./BrandOrb";
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
	/** The pair this destination morphs between: `idle` while another
	 *  destination is current, `current` when this one is. A rail is read by
	 *  glyph, so the glyph itself carries the selection — one icon that changes
	 *  shape, rather than a colour change on a shape that stays the same. */
	morphIcon?: { idle: IconInput; current: IconInput };
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
	expanded,
	onPeekPanel,
	onPeekEnd,
}: {
	item: RailItem;
	/** Wide rail: the row shows its label inline (KiroCrew's expanded nav rail).
	 *  Collapsed keeps the icon-only square with a hover tip, so a 52px strip
	 *  never reserves label width it cannot show. */
	expanded: boolean;
	onPeekPanel?: (panelId: string) => void;
	onPeekEnd?(): void;
}): ReactNode {
	const label = t(item.label);
	return (
		<button
			type="button"
			className={`gui-rail-btn${item.active ? " gui-rail-btn--active" : ""}${expanded ? " gui-rail-btn--wide" : ""}`}
			title={expanded ? undefined : label}
			aria-label={label}
			aria-current={item.active ? "page" : undefined}
			data-rail-destination={item.id}
			data-rail-panel={item.panelId}
			onClick={item.onSelect}
			onPointerEnter={item.panelId ? () => onPeekPanel?.(item.panelId as string) : undefined}
			onPointerLeave={item.panelId ? onPeekEnd : undefined}
		>
			{item.morphIcon ? (
				<MorphIcon
					icon={item.active ? item.morphIcon.current : item.morphIcon.idle}
					size={18}
					spring="snappy"
					reducedMotion="user"
					className="gui-rail-icon"
					aria-hidden
				/>
			) : (
				<Icon name={item.icon} className="gui-rail-icon" />
			)}
			{expanded ? <span className="gui-rail-label">{label}</span> : null}
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

/**
 * Account control — the user picture that replaced the rail's settings gear.
 *
 * One job per surface. This menu owns the account and the app: settings,
 * keyboard shortcuts, workspace remote access, disconnect. Three rows that
 * used to live here now have a single home elsewhere, because keeping them
 * made two adjacent popovers repeat each other with slightly different lists:
 *
 *  - **session sharing** belongs to the session header, which knows the
 *    session; the account entry cannot (it must work with no session open);
 *  - **host switching** belongs to the instance control in the rail footer,
 *    which already shows every host and its live status;
 *  - **instance management** belongs to that control's manager dialog, which
 *    covers both axes (where the daemon runs, where the files live); the
 *    endpoint-only dialog here was a second, thinner manager.
 *
 * Trigger state is self-managed; every action is the host's.
 */
export function UserAccountButton({
	rpc,
	cwd,
	connected,
	onOpenSettings,
	onOpenShortcuts,
	onOpenRemoteAccess,
	onDisconnect,
	compact = true,
	instanceMenu,
}: {
	rpc: RpcClient | null;
	/** Workspace the git identity is resolved from (the picture's source). */
	cwd: string;
	connected: boolean;
	onOpenSettings(): void;
	onOpenShortcuts?(): void;
	/** Share the WORKSPACE (mobile/browser join QR) — the rail's old
	 *  remote-control entry, kept as its own row because the session share
	 *  needs an open session and cannot replace it. */
	onOpenRemoteAccess?(): void;
	onDisconnect(): void;
	/** Rail geometry (36px square) vs the sidebar footer's inline control. */
	compact?: boolean;
	/** The instance section, rendered inside this menu. */
	instanceMenu?: ReactNode;
}): ReactNode {
	const btnRef = useRef<HTMLButtonElement | null>(null);
	const [open, setOpen] = useState(false);
	const user = useGitUser(rpc, cwd);
	const label = t("general.accountMenu");
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
				{/* The face and its status dot share one fixed-size box, so the dot
				 * stays put relative to the picture in both rail widths. Anchored to
				 * the BUTTON it moved with the button's width instead. */}
				<span className="gui-account-face">
					<UserAvatar rpc={rpc} cwd={cwd} />
					<span className={`gui-account-dot${connected ? " gui-account-dot--on" : ""}`} aria-hidden="true" />
				</span>
				{/* The wide rail names every row; this one had no text at all, so it
				 * read as an anonymous avatar while its neighbours were labelled. */}
				<span className="gui-rail-label gui-account-label">{label}</span>
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
				{/* The instance entry folded in here: host switching, version, latency
				 * and the connection manager were a second trigger sitting directly
				 * above this one, and two adjacent popovers listing the same hosts is
				 * the duplication this menu exists to avoid. */}
				{instanceMenu}
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

/** Where the repository lives. One constant: the rail, the release notices and
 *  the update dialog all point at the same project. */
const REPO_URL = "https://github.com/MuseLinn/MusePi";

/**
 * Community row: one line closing the rail — the GitHub mark, then the star and
 * issue links separated by a middot (KiroCrew's community row).
 *
 * One row, not two: these are the same destination (GitHub) and the pair reads
 * as a footer line rather than two more destinations. Both links are outbound,
 * so they are anchors; each carries its own accessible name because "Star" alone
 * names no target.
 *
 * The mark is decorative — it labels the GROUP, not either link — and it is the
 * one element on this line that stays when the rail folds, because an icon-only
 * rail still has to show that these links exist. The text folds away by height,
 * so the collapse stays smooth instead of the line vanishing.
 */
export function RailCommunityLinks({ expanded }: { expanded: boolean }): ReactNode {
	return (
		<div
			className={`gui-rail-community${expanded ? " gui-rail-community--open" : ""}`}
			{...(expanded ? {} : { inert: true })}
		>
			<div className="gui-rail-community-line">
				<span className="gui-rail-community-mark" aria-hidden="true">
					<Icon name="github" className="gui-rail-icon" />
				</span>
				<span className="gui-rail-community-links">
					<a
						href={REPO_URL}
						target="_blank"
						rel="noopener noreferrer"
						title={t("rail star repo")}
						aria-label={t("rail star repo")}
						className="gui-rail-community-link"
					>
						{t("rail star short")}
					</a>
					<span aria-hidden="true" className="gui-rail-community-sep">
						·
					</span>
					<a
						href={`${REPO_URL}/issues`}
						target="_blank"
						rel="noopener noreferrer"
						title={t("rail open issues")}
						aria-label={t("rail open issues")}
						className="gui-rail-community-link"
					>
						{t("rail issues short")}
					</a>
				</span>
			</div>
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
	community,
	expanded = false,
	onToggleExpanded,
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
	/** Wide rail: rows carry their labels and the brand header appears. The
	 *  narrow 52px strip is the same rail with labels withheld, so expanding is
	 *  a width change, not a different component. */
	expanded?: boolean;
	/** Present only where the rail may widen; its absence keeps the rail a
	 *  fixed icon strip (the settings preview renders it that way). */
	onToggleExpanded?(): void;
	/** The community line. Rendered AFTER the account so it closes the rail,
	 *  whatever order the host passes its other footer controls in. */
	community?: ReactNode;
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
			className={`gui-rail${expanded ? " gui-rail--wide" : ""}`}
			aria-label={t("general.appRail")}
			onDoubleClick={onBackgroundDoubleClick}
		>
			{/* Brand header: the mark IS the expand/collapse control, and the
			 * one persistent click target (KiroCrew's rail header). Unmounted
			 * where the rail cannot widen, so the settings preview and any
			 * fixed-strip host keep exactly the old markup. */}
			{onToggleExpanded ? (
				<div className="gui-rail-head">
					<button
						type="button"
						className="gui-rail-brand"
						onClick={onToggleExpanded}
						title={expanded ? t("transcript.closeSidebar") : t("transcript.openSidebar")}
						aria-label={expanded ? t("transcript.closeSidebar") : t("transcript.openSidebar")}
						aria-expanded={expanded}
					>
						{/* The product mark, not a generic panel glyph: this button is
						 * the one control present in both rail widths, so it carries the
						 * identity. `gui-brand-mark` is the same π badge the welcome
						 * header and error boundary render — one mark, one component —
						 * and the rail only scales it up for this slot. */}
						<span className="gui-rail-brand-mark" aria-hidden="true">
							<BrandOrb />
						</span>
						{expanded ? <span className="gui-rail-brand-text">{t("settings.musepi")}</span> : null}
						{/* Collapse affordance: an arrow to the edge, not a hide-panel
						 * glyph, because the rail folds rather than disappears. It
						 * fades in LAST (see the CSS delay) and sits out of flow, so it
						 * never reserves width and squeezes the mark while the rail is
						 * still narrow — the blink KiroCrew's header documents. */}
						{expanded ? (
							<span className="gui-rail-brand-arrow" aria-hidden="true">
								<Icon name="arrow-left-s" className="gui-rail-icon" />
							</span>
						) : null}
					</button>
				</div>
			) : (
				<div className="gui-rail-top" aria-hidden="true" />
			)}
			<div className="gui-rail-scroll">
				{destinations.map(item => (
					<RailButton
						key={item.id}
						item={item}
						expanded={expanded}
						onPeekPanel={onPeekPanel}
						onPeekEnd={onPeekEnd}
					/>
				))}
			</div>
			<div className="gui-rail-group">
				{footerActions}
				{account}
				{community}
			</div>
		</nav>
	);
}
