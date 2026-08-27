import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { openExternalUrl } from "../../lib/electron";
import { useConfirm, usePrompt } from "../../lib/prompt-dialog";
import type { RpcClient } from "../../lib/rpc";
import { Icon } from "../../vendor/oc-icons";

/** Read-only keyboard shortcut reference (openchamber parity). */
interface GitAuthState {
	installed?: boolean;
	authenticated?: boolean;
	login?: string;
	email?: string;
	avatarUrl?: string;
	active?: boolean;
	detail?: string;
}

interface GitDeviceFlow {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	expiresIn: number;
	interval: number;
}

interface GitIdentity {
	id: string;
	name: string;
	email: string;
}

/** Git settings (openchamber GitPage parity): GitHub OAuth via the gh CLI
 *  (device flow → gh auth login --with-token, so all gh RPCs pick it up)
 *  plus named commit identities. Identities are stored client-side
 *  (musepi-gui-git-identities) — no commit UI consumes them yet, but the
 *  default identity is what a future git commit flow should use. */
export function GitSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const { prompt } = usePrompt();
	const { confirm } = useConfirm();
	// ── GitHub auth ──────────────────────────────────────────────────────
	const [avatarFailed, setAvatarFailed] = useState(false);
	const [userAvatarMode, setUserAvatarMode] = useState<string>(() => {
		try {
			return localStorage.getItem("musepi-gui-user-avatar-mode") ?? "auto";
		} catch {
			return "auto";
		}
	});
	const pickUserAvatarMode = (mode: "auto" | "punk" | "initial"): void => {
		setUserAvatarMode(mode);
		try {
			localStorage.setItem("musepi-gui-user-avatar-mode", mode);
		} catch {
			// storage unavailable — session-only choice
		}
		window.dispatchEvent(new CustomEvent("omp-avatar-changed"));
	};
	const [auth, setAuth] = useState<GitAuthState | null>(null);
	const [authLoading, setAuthLoading] = useState(false);
	const [flow, setFlow] = useState<GitDeviceFlow | null>(null);
	const [flowError, setFlowError] = useState<string | null>(null);
	const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const refreshAuth = useCallback(async (): Promise<void> => {
		if (!rpc) return;
		setAuthLoading(true);
		try {
			const next = await rpc.request<GitAuthState>("github.authStatus", {});
			setAuth(next);
			// Sync the GitHub avatar to the chat user bubble (UserAvatar
			// reads this key synchronously — zero RPC per message).
			if (next?.avatarUrl) localStorage.setItem("musepi-gui-user-avatar", next.avatarUrl);
			else localStorage.removeItem("musepi-gui-user-avatar");
		} catch (err) {
			// RPC failure (e.g. daemon predates github.authStatus) is NOT the
			// same as gh missing — keep the detail so the UI can say so.
			setAuth({ installed: false, detail: err instanceof Error ? err.message : String(err) });
		} finally {
			setAuthLoading(false);
		}
	}, [rpc]);

	useEffect(() => {
		void refreshAuth();
		return () => {
			if (pollRef.current) clearTimeout(pollRef.current);
		};
	}, [refreshAuth]);

	// new login → re-enable the avatar image (previous one may have failed)
	useEffect(() => {
		setAvatarFailed(false);
	}, []);

	const stopFlow = (): void => {
		if (pollRef.current) clearTimeout(pollRef.current);
		pollRef.current = null;
		setFlow(null);
		setFlowError(null);
		setCopied(false);
	};

	const [copied, setCopied] = useState(false);
	const copyCode = async (): Promise<void> => {
		if (!flow) return;
		try {
			await navigator.clipboard.writeText(flow.userCode);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// clipboard unavailable — code stays visible for manual entry
		}
	};

	const pollFlow = useCallback(
		async (flowState: GitDeviceFlow): Promise<void> => {
			if (!rpc) return;
			try {
				const res = await rpc.request<{
					pending?: boolean;
					interval?: number;
					connected?: boolean;
					login?: string;
					error?: string;
				}>("github.authPoll", { deviceCode: flowState.deviceCode, interval: flowState.interval });
				if (res.pending) {
					pollRef.current = setTimeout(
						() => void pollFlow(flowState),
						(res.interval ?? flowState.interval) * 1000,
					);
					return;
				}
				if (res.connected) {
					setFlow(null);
					void refreshAuth();
					return;
				}
				stopFlow();
				setFlowError(res.error ?? t("github auth failed"));
			} catch (err) {
				stopFlow();
				setFlowError(err instanceof Error ? err.message : String(err));
			}
		},
		[rpc, refreshAuth, stopFlow],
	);

	const startFlow = async (): Promise<void> => {
		if (!rpc) return;
		setFlowError(null);
		try {
			const res = await rpc.request<GitDeviceFlow | { error?: string }>("github.authStart", {});
			if ("error" in res && res.error) {
				setFlowError(res.error);
				return;
			}
			const started = res as GitDeviceFlow;
			setFlow(started);
			void openExternalUrl(started.verificationUri);
			pollRef.current = setTimeout(() => void pollFlow(started), Math.max(5, started.interval) * 1000);
		} catch (err) {
			setFlowError(err instanceof Error ? err.message : String(err));
		}
	};

	const disableAuth = async (): Promise<void> => {
		if (!rpc) return;
		const ok = await confirm(t("confirm disable github auth"));
		if (!ok) return;
		setAuthLoading(true);
		try {
			await rpc.request("github.authLogout", {});
		} finally {
			await refreshAuth();
		}
	};

	// ── Identities ───────────────────────────────────────────────────────
	const [identities, setIdentities] = useState<GitIdentity[]>(() => {
		try {
			const raw = localStorage.getItem("musepi-gui-git-identities");
			return raw ? (JSON.parse(raw) as GitIdentity[]) : [];
		} catch {
			return [];
		}
	});
	const [defaultIdentity, setDefaultIdentity] = useState<string | null>(() => {
		try {
			return localStorage.getItem("musepi-gui-git-default-identity");
		} catch {
			return null;
		}
	});
	const saveIdentities = (next: GitIdentity[]): void => {
		setIdentities(next);
		try {
			localStorage.setItem("musepi-gui-git-identities", JSON.stringify(next));
		} catch {
			// storage unavailable
		}
	};
	const addIdentity = async (): Promise<void> => {
		const name = await prompt({ title: t("new identity name"), placeholder: t("identity name") });
		if (!name) return;
		const email = await prompt({ title: t("new identity email"), placeholder: t("identity email") });
		if (!email) return;
		const id = crypto.randomUUID();
		saveIdentities([...identities, { id, name, email }]);
		if (!defaultIdentity) {
			setDefaultIdentity(id);
			try {
				localStorage.setItem("musepi-gui-git-default-identity", id);
			} catch {
				// storage unavailable
			}
		}
	};
	const removeIdentity = async (id: string): Promise<void> => {
		const ok = await confirm(t("confirm delete identity"));
		if (!ok) return;
		saveIdentities(identities.filter(i => i.id !== id));
		if (defaultIdentity === id) {
			setDefaultIdentity(null);
			try {
				localStorage.removeItem("musepi-gui-git-default-identity");
			} catch {
				// storage unavailable
			}
		}
	};

	return (
		<>
			<h2 className="gui-settings-page-title">{t("git settings")}</h2>
			<p className="gui-settings-page-desc">{t("git settings description")}</p>

			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("github oauth token")}</div>
				<div className="gui-settings-section-desc">{t("github oauth token description")}</div>
				{authLoading && !auth ? (
					<div className="gui-settings-row">
						<div className="gui-settings-row-desc">{t("loading")}</div>
					</div>
				) : auth?.installed === false ? (
					<div className="gui-settings-row">
						<div className="gui-settings-row-desc">
							{t("gh cli not installed")}
							{auth.detail && <span className="block text-[12px] opacity-70">({auth.detail})</span>}
						</div>
					</div>
				) : auth?.authenticated ? (
					<div className="gui-github-card">
						{auth.avatarUrl && !avatarFailed ? (
							<img
								src={auth.avatarUrl}
								alt=""
								className="gui-github-avatar-img"
								onError={() => setAvatarFailed(true)}
							/>
						) : (
							<div className="gui-github-avatar">{auth.login?.slice(0, 1).toUpperCase() ?? "?"}</div>
						)}
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-1.5">
								<Icon name="github" className="h-3.5 w-3.5" />
								<span className="font-medium">{auth.login ?? t("unknown")}</span>
								{auth.email && (
									<span className="text-[12px] text-[var(--color-text-muted)]">· {auth.email}</span>
								)}
							</div>
							<div className="text-[12px] text-[var(--color-text-muted)]">{t("authenticated via gh cli")}</div>
						</div>
						<button type="button" className="gui-btn" disabled={authLoading} onClick={() => void disableAuth()}>
							{t("disable")}
						</button>
					</div>
				) : (
					<div className="gui-settings-row">
						<div className="gui-settings-row-desc">{auth?.detail || t("not authenticated via gh cli")}</div>
					</div>
				)}
				{flow && (
					<div className="gui-github-flow">
						<div className="gui-github-flow-title">{t("authorize device")}</div>
						<div className="gui-github-flow-hint">{t("github device flow hint")}</div>
						<div className="gui-github-flow-code-row">
							<code className="gui-github-flow-code">{flow.userCode}</code>
							<button type="button" className="gui-btn gui-github-flow-copy" onClick={() => void copyCode()}>
								{copied ? t("code copied") : t("copy code")}
							</button>
						</div>
						<div className="gui-github-flow-actions">
							<button
								type="button"
								className="gui-btn gui-btn-primary"
								onClick={() => void openExternalUrl(flow.verificationUri)}
							>
								<Icon name="external-link" className="h-3.5 w-3.5" />
								{t("open github")}
							</button>
							<button type="button" className="gui-link" onClick={stopFlow}>
								{t("cancel")}
							</button>
						</div>
						<div className="gui-github-flow-waiting">
							<span className="gui-flow-spinner" aria-hidden="true" />
							{t("waiting approval")}
						</div>
					</div>
				)}
				{flowError && <div className="mt-2 text-[12.5px] text-[var(--color-danger)]">{flowError}</div>}
				{!auth?.authenticated && !flow && (
					<div className="mt-2 flex justify-center">
						<button type="button" className="gui-btn" disabled={authLoading} onClick={() => void startFlow()}>
							<Icon name="add" className="h-3.5 w-3.5" />
							{t("add account")}
						</button>
					</div>
				)}
			</div>

			<div className="gui-settings-row">
				<div>
					<div className="gui-settings-row-label">{t("user avatar source")}</div>
					<div className="gui-settings-row-desc">{t("user avatar source description")}</div>
				</div>
				<div className="flex items-center gap-1">
					{(
						[
							["auto", t("user avatar auto")],
							["punk", t("user avatar punk")],
							["initial", t("user avatar initial")],
						] as const
					).map(([mode, label]) => (
						<button
							key={mode}
							type="button"
							className={`gui-avatar-opt${userAvatarMode === mode ? " gui-avatar-opt--active" : ""}`}
							title={label}
							aria-pressed={userAvatarMode === mode}
							onClick={() => pickUserAvatarMode(mode)}
						>
							<span className="px-1 text-[11px] font-medium">{label}</span>
						</button>
					))}
				</div>
			</div>

			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("git preferences")}</div>
				<div className="gui-settings-section-desc">{t("git preferences description")}</div>
				<GitPrefsRow />
			</div>

			<div className="gui-settings-section">
				<div className="flex items-center justify-between">
					<div>
						<div className="gui-settings-section-title">{t("identities")}</div>
						<div className="gui-settings-section-desc">{t("identities description")}</div>
					</div>
					<button type="button" className="gui-btn" onClick={() => void addIdentity()}>
						<Icon name="add" className="h-3.5 w-3.5" />
						{t("new identity")}
					</button>
				</div>
				{identities.length === 0 ? (
					<div className="gui-settings-row">
						<div className="gui-settings-row-desc">{t("no identities yet")}</div>
					</div>
				) : (
					identities.map(idt => (
						<div key={idt.id} className="gui-identity-row">
							<Icon name="user-3" className="h-4 w-4 text-[var(--color-text-faint)]" />
							<div className="min-w-0 flex-1">
								<div className="text-[13.5px]">
									{idt.name}
									{defaultIdentity === idt.id && <span className="gui-identity-default">{t("default")}</span>}
								</div>
								<div className="text-[12px] text-[var(--color-text-muted)]">{idt.email}</div>
							</div>
							<button
								type="button"
								className="gui-view-opt"
								title={t("set default")}
								aria-label={t("set default")}
								disabled={defaultIdentity === idt.id}
								onClick={() => {
									setDefaultIdentity(idt.id);
									try {
										localStorage.setItem("musepi-gui-git-default-identity", idt.id);
									} catch {
										// storage unavailable
									}
								}}
							>
								<Icon name="check" className="h-3.5 w-3.5" />
							</button>
							<button
								type="button"
								className="gui-view-opt gui-view-opt--danger"
								title={t("delete")}
								aria-label={t("delete")}
								onClick={() => void removeIdentity(idt.id)}
							>
								<Icon name="delete-bin" className="h-3.5 w-3.5" />
							</button>
						</div>
					))
				)}
			</div>
		</>
	);
}

/** openchamber GitSettings parity: changes-view mode, gitmoji picker and
 *  show-gitignored — consumed by the right-pane DiffPane (same keys). */
export function GitPrefsRow(): ReactNode {
	const [view, setViewState] = useState<"flat" | "tree">(() =>
		localStorage.getItem("musepi-gui-git-view") === "tree" ? "tree" : "flat",
	);
	const [gitmoji, setGitmoji] = useState<boolean>(() => localStorage.getItem("musepi-gui-gitmoji") !== "0");
	const [showIgnored, setShowIgnored] = useState<boolean>(
		() => localStorage.getItem("musepi-gui-git-show-ignored") === "1",
	);
	return (
		<>
			<div className="gui-settings-row">
				<div>
					<div className="gui-settings-row-label">{t("changes view")}</div>
					<div className="gui-settings-row-desc">{t("changes view description")}</div>
				</div>
				<div className="gui-segmented">
					<button
						type="button"
						className={`gui-seg-btn${view === "flat" ? " gui-seg-btn--active" : ""}`}
						onClick={() => {
							setViewState("flat");
							localStorage.setItem("musepi-gui-git-view", "flat");
						}}
					>
						{t("flat list")}
					</button>
					<button
						type="button"
						className={`gui-seg-btn${view === "tree" ? " gui-seg-btn--active" : ""}`}
						onClick={() => {
							setViewState("tree");
							localStorage.setItem("musepi-gui-git-view", "tree");
						}}
					>
						{t("tree view")}
					</button>
				</div>
			</div>
			<div className="gui-settings-row">
				<div>
					<div className="gui-settings-row-label">{t("enable gitmoji picker")}</div>
					<div className="gui-settings-row-desc">{t("enable gitmoji picker description")}</div>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={gitmoji}
					className={`gui-toggle${gitmoji ? " gui-toggle--on" : ""}`}
					onClick={() => {
						const next = !gitmoji;
						setGitmoji(next);
						localStorage.setItem("musepi-gui-gitmoji", next ? "1" : "0");
						// Live consumers (ContextPanel gitmojiOn badge) re-read
						// on this event — same-window storage events don't fire.
						window.dispatchEvent(new CustomEvent("omp-gitmoji-changed"));
					}}
					aria-label={t("enable gitmoji picker")}
				>
					<span className="gui-toggle-knob" />
				</button>
			</div>
			<div className="gui-settings-row">
				<div>
					<div className="gui-settings-row-label">{t("show gitignored")}</div>
					<div className="gui-settings-row-desc">{t("show gitignored description")}</div>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={showIgnored}
					className={`gui-toggle${showIgnored ? " gui-toggle--on" : ""}`}
					onClick={() => {
						const next = !showIgnored;
						setShowIgnored(next);
						localStorage.setItem("musepi-gui-git-show-ignored", next ? "1" : "0");
					}}
					aria-label={t("show gitignored")}
				>
					<span className="gui-toggle-knob" />
				</button>
			</div>
		</>
	);
}
