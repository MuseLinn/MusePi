import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { Icon } from "../vendor/oc-icons";
import { QrCode } from "../vendor/qrcode";
import { DialogFrame } from "./DialogFrame";

interface CollabInfo {
	hosting: boolean;
	link?: string;
	webLink?: string;
	viewLink?: string;
}

/** Draw a QR symbol (collab-proto encoder, byte mode) onto a canvas. */
function drawQr(canvas: HTMLCanvasElement, text: string): void {
	const qr = QrCode.encodeText(text, "M");
	const scale = 6;
	const quiet = 4;
	const size = (qr.size + quiet * 2) * scale;
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, size, size);
	ctx.fillStyle = "#111111";
	for (let y = 0; y < qr.size; y++) {
		for (let x = 0; x < qr.size; x++) {
			if (qr.module(x, y)) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
		}
	}
}

/**
 * ZCode 移动端远程控制 dialog: scan-to-join a live collab share of the
 * current session (daemon collab.* RPC, LAN relay), plus the bot-channel
 * section (unconfigured placeholder — no bot backend exists).
 */
/** 各 bot channel 的可识别 logo（discord 用内置 icon，其余内联简化 SVG）。 */
function channelLogo(kind: string): ReactNode {
	switch (kind) {
		case "discord":
			return <Icon name="discord-fill" className="h-4 w-4 text-white" />;
		case "telegram":
			return (
				<svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true" fill="currentColor">
					<path d="M21.6 3.2 3.2 10.5c-.9.4-.9 1.6 0 1.9l4.7 1.6 1.8 5.7c.2.7 1 .9 1.5.5l2.5-2 4.7 3.5c.7.6 1.8.2 2-.7l2.7-14.5c.3-1.1-.7-2-1.8-1.8z" />
				</svg>
			);
		case "wechat":
			return (
				<svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true" fill="currentColor">
					<path d="M9.2 3C5.5 3 2.7 5.3 2.7 8.3c0 1.6.9 3.1 2.4 4l-.6 2 2.3-1.2c.8.2 1.5.3 2.4.3 3.7 0 6.5-2.3 6.5-5.1S12.9 3 9.2 3zm-2.4 6c-.5 0-.9-.4-.9-.8s.4-.8.9-.8.9.4.9.8-.4.8-.9.8zm4.8 0c-.5 0-.9-.4-.9-.8s.4-.8.9-.8.9.4.9.8-.4.8-.9.8zm5.1 4.2c-2.9 0-5.2 1.9-5.2 4.3S14 21.8 16.8 21.8c.7 0 1.3-.1 1.9-.3l1.9 1-.6-1.7c1.1-.8 1.8-2 1.8-3.3 0-2.4-2.4-4.3-5.3-4.3z" />
				</svg>
			);
		case "feishu":
		case "lark":
			return (
				<svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true" fill="currentColor">
					<path d="M12 2 3 9l9 4 9-4-9-7zm-7 9.3v2.9L12 18l7-3.8v-2.9L12 15l-7-3.7z" />
				</svg>
			);
		case "huawei-today":
			return (
				<svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true" fill="currentColor">
					<path d="M12 2c1.4 3.2 3 6 7.5 8-4.5 2-6.1 4.8-7.5 8-1.4-3.2-3-6-7.5-8 4.5-2 6.1-4.8 7.5-8z" />
				</svg>
			);
		default:
			return null;
	}
}

export function CollabDialog({
	rpc,
	sessionId,
	sessionTitle,
	open,
	onClose,
}: {
	rpc: RpcClient | null;
	sessionId: string | null;
	sessionTitle: string | null;
	open: boolean;
	onClose(): void;
}): ReactNode {
	const [info, setInfo] = useState<CollabInfo | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const qrRef = useRef<HTMLCanvasElement | null>(null);
	const [webLink, setWebLink] = useState<string | null>(null);
	const [mode, setMode] = useState<"session" | "workspace" | "tunnel">("session");
	const [pairCode, setPairCode] = useState<string | null>(null);
	const [channels, setChannels] = useState<
		{ kind: string; state: string; detail?: string; config: Record<string, unknown> }[] | null
	>(null);
	const [expandedKind, setExpandedKind] = useState<string | null>(null);
	const [configDraft, setConfigDraft] = useState<Record<string, string>>({});
	const [plugins, setPlugins] = useState<
		{ kind: string; label: string; origin: string; registered: boolean }[] | null
	>(null);

	const refreshPlugins = async (): Promise<void> => {
		if (!rpc) return;
		try {
			const list = await rpc.request<{ kind: string; label: string; origin: string; registered: boolean }[]>(
				"channels.plugins",
				{},
			);
			setPlugins(list);
		} catch {
			setPlugins([]);
		}
	};

	const reloadPlugins = async (): Promise<void> => {
		if (!rpc) return;
		await rpc
			.request("channels.reloadPlugins", {})
			.then(() => Promise.all([refreshChannels(), refreshPlugins()]))
			.catch(() => {});
	};

	const saveConfig = async (kind: string): Promise<void> => {
		if (!rpc) return;
		await rpc
			.request("channels.configure", { kind, config: configDraft })
			.then(() => rpc.request("channels.start", { kind }))
			.then(() => refreshChannels())
			.catch(() => refreshChannels());
		setExpandedKind(null);
		setConfigDraft({});
	};

	const channelFields: Record<string, { key: string; label: string; secret: boolean }[]> = {
		discord: [{ key: "token", label: "Bot token", secret: true }],
		wechat: [{ key: "token", label: "Token (optional — QR login if empty)", secret: true }],
		"huawei-today": [
			{ key: "apiKey", label: "PERSONAL-API-KEY", secret: true },
			{ key: "uid", label: "PERSONAL-UID", secret: false },
		],
	};

	const refreshChannels = async (): Promise<void> => {
		if (!rpc) return;
		try {
			const list = await rpc.request<
				{ kind: string; state: string; detail?: string; config: Record<string, unknown> }[]
			>("channels.list", {});
			setChannels(list);
		} catch {
			setChannels([]);
		}
	};

	const genPairCode = async (): Promise<void> => {
		if (!rpc) return;
		try {
			const res = await rpc.request<{ code: string; expiresInSeconds: number }>("collab.pair.generate", {});
			setPairCode(res.code);
		} catch {
			setPairCode(null);
		}
	};

	const refresh = async (): Promise<void> => {
		if (!rpc) return;
		try {
			const st = await rpc.request<CollabInfo>("collab.status", {
				...(sessionId !== null ? { sessionId } : {}),
			});
			setInfo(st);
			if (st.hosting && st.webLink) setWebLink(st.webLink);
		} catch {
			setInfo({ hosting: false });
		}
	};

	useEffect(() => {
		void refresh();
		void refreshChannels();
		void refreshPlugins();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [refresh]);

	useEffect(() => {
		if (webLink && qrRef.current) drawQr(qrRef.current, webLink);
	}, [webLink]);

	const startShare = async (): Promise<void> => {
		if (!rpc || (mode === "session" && !sessionId)) return;
		setBusy(true);
		setError(null);
		try {
			const res = await rpc.request<CollabInfo>("collab.start", {
				...(sessionId !== null ? { sessionId } : {}),
				mode,
			});
			setInfo({ ...res, hosting: true });
			if (res.webLink) setWebLink(res.webLink);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const stopShare = async (): Promise<void> => {
		if (!rpc) return;
		await rpc
			.request("collab.stop", {
				...(sessionId !== null ? { sessionId } : {}),
			})
			.catch(() => {});
		setInfo({ hosting: false });
		setWebLink(null);
	};

	const copyLink = async (): Promise<void> => {
		if (!webLink) return;
		try {
			await navigator.clipboard.writeText(webLink);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// clipboard unavailable
		}
	};

	const hosting = info?.hosting ?? false;
	// Tunnel mode needs no session: it shares the workspace when no session
	// is open (daemon treats tunnel-without-sessionId as workspace mode).
	const canShare = !busy && rpc !== null && (mode === "workspace" || mode === "tunnel" || sessionId !== null);
	const sessionHint =
		sessionId !== null && sessionTitle
			? t(`share session "{title}" live on the local network`, { title: sessionTitle })
			: t("share this session live on the local network");

	return (
		<DialogFrame open={open} onClose={onClose} label={t("mobile remote control")} className="gui-collab-dialog">
			<div className="gui-dialog-head">
				<span className="text-[14px] font-semibold">{t("mobile remote control")}</span>
				<button type="button" className="gui-tool-btn" onClick={onClose} aria-label={t("close")}>
					<Icon name="close" className="h-4 w-4" />
				</button>
			</div>
			<div className="gui-collab-grid">
				{/* Left: scan-to-connect (ZCode layout). */}
				<section className="gui-collab-col">
					<div className="gui-collab-col-head">
						<Icon name="smartphone" className="h-4 w-4" />
						<span>{t("scan to connect")}</span>
					</div>
					<p className="gui-collab-desc">{t("scan with your phone camera to open this workspace")}</p>
					<div className="gui-collab-status">
						<span className="gui-collab-dot" />
						<span>{hosting ? t("waiting for phone connection") : t("ready")}</span>
						{hosting && (
							<button type="button" className="gui-btn gui-btn-stop ml-auto" onClick={() => void stopShare()}>
								<Icon name="stop" className="h-3 w-3" />
								<span>{t("stop")}</span>
							</button>
						)}
					</div>
					{error && <div className="gui-collab-error">{error}</div>}
					{hosting && webLink ? (
						<>
							<div className="gui-collab-qr">
								<canvas ref={qrRef} />
							</div>
							<div className="gui-collab-actions">
								<button type="button" className="gui-btn" onClick={() => void refresh()}>
									<Icon name="refresh" className="h-3.5 w-3.5" />
									<span>{t("refresh qr code")}</span>
								</button>
								<button type="button" className="gui-btn" onClick={() => void copyLink()}>
									<Icon name="external-link" className="h-3.5 w-3.5" />
									<span>{copied ? t("copied") : t("copy link")}</span>
								</button>
							</div>
							{/* MusePi Mobile pair code: no-camera fallback to the QR. */}
							<div className="gui-collab-pair">
								<span className="text-[12px] text-[var(--color-text-faint)]">
									{t("or use MusePi Mobile pair code")}
								</span>
								<div className="gui-collab-pair-row">
									<span className="gui-collab-pair-code">{pairCode ?? "——————"}</span>
									<button type="button" className="gui-btn" onClick={() => void genPairCode()}>
										<Icon name="refresh" className="h-3.5 w-3.5" />
										<span>{t("get code")}</span>
									</button>
								</div>
								<span className="text-[11px] text-[var(--color-text-faint)]">
									{t("enter the 6-digit code in MusePi Mobile (same network)")}
								</span>
							</div>
						</>
					) : (
						<div className="gui-collab-idle">
							<div className="gui-segmented">
								<button
									type="button"
									className={`gui-seg-btn${mode === "session" ? " gui-seg-btn--active" : ""}`}
									onClick={() => setMode("session")}
								>
									{t("current session")}
								</button>
								<button
									type="button"
									className={`gui-seg-btn${mode === "workspace" ? " gui-seg-btn--active" : ""}`}
									onClick={() => setMode("workspace")}
								>
									{t("workspace")}
								</button>
								<button
									type="button"
									className={`gui-seg-btn${mode === "tunnel" ? " gui-seg-btn--active" : ""}`}
									onClick={() => setMode("tunnel")}
								>
									{t("public tunnel")}
								</button>
							</div>
							<button
								type="button"
								className="gui-btn gui-btn-primary"
								disabled={!canShare}
								onClick={() => void startShare()}
							>
								<Icon name="send-plane" className="h-3.5 w-3.5" />
								<span>{busy ? t("starting…") : t("start sharing")}</span>
							</button>
							<p className="gui-collab-hint">
								{sessionId === null && mode === "session"
									? t("open or create a session first to share it")
									: mode === "workspace"
										? t("share the whole workspace — guests see every session")
										: mode === "tunnel"
											? t("public tunnel — anyone with the link can join; stop sharing to close it")
											: sessionHint}
							</p>
						</div>
					)}
				</section>
				{/* Right: bot channels (live status from daemon). */}
				<section className="gui-collab-col">
					<div className="gui-collab-col-head">
						<Icon name="robot" className="h-4 w-4" />
						<span>{t("use bot channel")}</span>
					</div>
					<p className="gui-collab-desc">{t("connect a chat bot for longer mobile access")}</p>
					<div className="gui-collab-bots">
						{(channels ?? []).map(c => {
							const label = c.kind;
							const on = c.state === "connected" || c.state === "connecting" || c.state === "waiting_scan";
							const fields = channelFields[c.kind];
							return (
								<div key={c.kind} className="gui-collab-bot-wrap">
									<div className={`gui-collab-bot${on ? "" : " gui-collab-bot--off"}`}>
										<span className={`gui-collab-bot-ico gui-collab-bot-ico--${c.kind}`}>
											{channelLogo(c.kind)}
										</span>
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2">
												<span className="text-[13px] font-medium capitalize">{label}</span>
												<span className={`gui-collab-dot${on ? "" : " gui-collab-dot--off"}`} />
											</div>
											<div className="truncate text-[12px] text-[var(--color-text-faint)]">
												{c.detail ?? (c.state === "off" ? t("off") : c.state)}
											</div>
										</div>
										<button
											type="button"
											className="gui-btn gui-btn-sm"
											disabled={c.state === "connecting"}
											onClick={() => {
												if (on) {
													void rpc
														?.request("channels.stop", { kind: c.kind })
														.then(() => refreshChannels())
														.catch(() => refreshChannels());
												} else {
													setExpandedKind(expandedKind === c.kind ? null : c.kind);
												}
											}}
										>
											{on ? t("stop") : t("start")}
										</button>
									</div>
									{expandedKind === c.kind && fields && (
										<div className="gui-collab-channel-config">
											{fields.map(f => (
												<input
													key={f.key}
													className="gui-collab-channel-input"
													type={f.secret ? "password" : "text"}
													placeholder={f.label}
													value={configDraft[f.key] ?? ""}
													onChange={e => setConfigDraft(d => ({ ...d, [f.key]: e.target.value }))}
													autoComplete="off"
												/>
											))}
											<button
												type="button"
												className="gui-btn gui-btn-primary gui-btn-sm"
												disabled={!fields.every(f => (configDraft[f.key] ?? "").trim())}
												onClick={() => void saveConfig(c.kind)}
											>
												{t("save and start")}
											</button>
										</div>
									)}
								</div>
							);
						})}
						{(channels ?? []).length === 0 && (
							<div className="text-[12px] text-[var(--color-text-faint)]">{t("no channels configured")}</div>
						)}
					</div>
					{/* Plugin inventory (game-mod style): builtin + hot-plugged
					 * channel modules; reload rescans the plugin directory. */}
					<div className="mt-2 border-t border-[var(--border)] pt-2">
						<div className="flex items-center justify-between">
							<span className="text-[11px] uppercase tracking-wider text-[var(--color-text-faint)]">
								{t("channel plugins")}
							</span>
							<button
								type="button"
								className="gui-btn gui-btn-sm"
								title={t("reload plugins")}
								onClick={() => void reloadPlugins()}
							>
								<Icon name="refresh" className="h-3 w-3" />
							</button>
						</div>
						<div className="mt-1 flex flex-wrap gap-1">
							{(plugins ?? []).map(p => (
								<span
									key={p.kind}
									className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--color-text-muted)]"
									title={p.origin}
								>
									{p.label}
								</span>
							))}
							{(plugins ?? []).length === 0 && (
								<span className="text-[11px] text-[var(--color-text-faint)]">{t("no plugins")}</span>
							)}
						</div>
					</div>
				</section>
			</div>
		</DialogFrame>
	);
}
