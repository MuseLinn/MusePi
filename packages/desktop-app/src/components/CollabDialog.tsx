import { Segmented, type SegmentedOption, t } from "@musepi/guest-client";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useConfirm } from "../lib/prompt-dialog";
import type { RpcClient } from "../lib/rpc";
import { Icon } from "../vendor/oc-icons";
import { QrCode } from "../vendor/qrcode";
import { DialogFrame } from "./DialogFrame";
import { Reveal } from "./Reveal";

/** Share scope: what the guest link exposes. */
const SHARE_SCOPE_SEGMENTS: SegmentedOption<"session" | "workspace" | "tunnel">[] = [
	{ value: "session", label: t("current session") },
	{ value: "workspace", label: t("workspace") },
	{ value: "tunnel", label: t("public tunnel") },
];

interface CollabGuest {
	name: string;
	role: string;
	readOnly: boolean;
}

interface CollabInfo {
	hosting: boolean;
	link?: string;
	webLink?: string;
	viewLink?: string;
	participants?: CollabGuest[];
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
 * section (live daemon state — channels.list/start/stop).
 */
/** iLink's `qrcode_img_content` is NOT an image — live API returns the URL
 *  the QR must ENCODE (the liteapp.weixin.qq.com scan target; rendering it
 *  as <img> 404s and was the "二维码不显示" bug). So an https URL is
 *  rasterized HERE with the built-in QR encoder (crisp SVG data URI). A real
 *  image URL (ending in an image extension) still renders as <img>, and a
 *  raw base64 PNG (older adapter shape) gets the data:image wrapper. */
function channelQrSrc(raw: string): string {
	if (raw.startsWith("data:")) return raw;
	if (/^https?:\/\//i.test(raw)) {
		if (/\.(png|jpe?g|gif|webp)([?#]|$)/i.test(raw)) return raw;
		const qr = QrCode.encodeText(raw, "M");
		const cells: string[] = [];
		for (let y = 0; y < qr.size; y++) {
			for (let x = 0; x < qr.size; x++) {
				if (qr.module(x, y)) cells.push(`M${x} ${y}h1v1h-1z`);
			}
		}
		const svg =
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${qr.size} ${qr.size}" shape-rendering="crispEdges">` +
			`<rect width="100%" height="100%" fill="#fff"/><path d="${cells.join("")}" fill="#000"/></svg>`;
		return `data:image/svg+xml,${encodeURIComponent(svg)}`;
	}
	return `data:image/png;base64,${raw}`;
}
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
	const { confirm } = useConfirm();
	const qrRef = useRef<HTMLCanvasElement | null>(null);
	const [webLink, setWebLink] = useState<string | null>(null);
	const [mode, setMode] = useState<"session" | "workspace" | "tunnel">("session");
	const [pairCode, setPairCode] = useState<string | null>(null);
	/** When the live pair code dies; null until one is minted. */
	const [pairCodeExpiresAt, setPairCodeExpiresAt] = useState<number | null>(null);
	/** 1s clock driving the pair-code countdown; only ticks while a code is live. */
	const [now, setNow] = useState(() => Date.now());
	/** Watch-only link copy feedback (mirrors `copied`). */
	const [copiedView, setCopiedView] = useState(false);
	const [channels, setChannels] = useState<
		{ kind: string; state: string; detail?: string; config: Record<string, unknown> }[] | null
	>(null);
	const [expandedKind, setExpandedKind] = useState<string | null>(null);
	const [configDraft, setConfigDraft] = useState<Record<string, string>>({});
	/** Per-kind start failure — silently swallowing channels.start errors left
	 *  users clicking "start" with zero feedback (QR never appeared). */
	const [startErrors, setStartErrors] = useState<Record<string, string>>({});
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
		setStartErrors(e => ({ ...e, [kind]: "" }));
		try {
			await rpc.request("channels.configure", { kind, config: configDraft });
			await rpc.request("channels.start", { kind });
			// Only collapse on success — keep the form open on failure so the
			// error lands next to the fields the user just filled.
			setExpandedKind(null);
		} catch (err) {
			setStartErrors(e => ({ ...e, [kind]: err instanceof Error ? err.message : String(err) }));
		}
		await refreshChannels();
		setConfigDraft({});
	};

	/** Direct start for channels without a config form (hot-plugged plugin
	 *  channels): previously the 启动 button silently expanded nothing and
	 *  the channel was unreachable from the GUI. Uses the persisted config;
	 *  failures surface in the row (same startErrors channel as the form). */
	const startChannel = async (kind: string): Promise<void> => {
		if (!rpc) return;
		setStartErrors(e => ({ ...e, [kind]: "" }));
		try {
			await rpc.request("channels.start", { kind });
		} catch (err) {
			setStartErrors(e => ({ ...e, [kind]: err instanceof Error ? err.message : String(err) }));
		}
		await refreshChannels();
	};

	/** 解绑 (unlink): stop the channel AND drop its persisted credentials.
	 *  Destructive (the next start needs a fresh QR login), so it sits behind
	 *  a confirm dialog — Enter confirms, Escape cancels (prompt-dialog). */
	const unlinkChannel = async (kind: string): Promise<void> => {
		if (!rpc) return;
		const ok = await confirm(t("unlink channel confirm"), t("unlink"));
		if (!ok) return;
		await rpc.request("channels.unlink", { kind }).catch(() => {});
		await refreshChannels();
	};

	const channelFields: Record<string, { key: string; label: string; secret: boolean; optional?: boolean }[]> = {
		discord: [{ key: "token", label: "Bot token", secret: true }],
		// token optional: empty → the channel falls back to QR login (wechat.ts
		// start(): #fetchQr + waiting_scan). The save button must not lock on it
		// (issue #28) — the QR itself is rendered from status().config.qrUrl.
		wechat: [{ key: "token", label: "Token (optional — QR login if empty)", secret: true, optional: true }],
		"huawei-today": [
			{ key: "apiKey", label: "PERSONAL-API-KEY", secret: true },
			{ key: "uid", label: "PERSONAL-UID", secret: false },
		],
		// Missing forms used to leave these rows dead: clicking 启动 expanded
		// nothing (fields undefined) and the channel could never be started
		// from the GUI — the adapter-side required config lived only in the
		// daemon (telegram.ts needs token; feishu.ts needs appId/appSecret).
		telegram: [{ key: "token", label: "Bot token (from @BotFather)", secret: true }],
		feishu: [
			{ key: "appId", label: "App ID", secret: false },
			{ key: "appSecret", label: "App Secret", secret: true },
		],
		lark: [
			{ key: "appId", label: "App ID", secret: false },
			{ key: "appSecret", label: "App Secret", secret: true },
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
			setPairCodeExpiresAt(Date.now() + res.expiresInSeconds * 1000);
			setNow(Date.now());
		} catch {
			setPairCode(null);
			setPairCodeExpiresAt(null);
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

	// While a channel is mid-login (connecting / waiting_scan) poll its status
	// so the QR appears and a completed scan flips the row to "connected"
	// without manual refresh. Idle channels schedule nothing.
	const pendingChannel = (channels ?? []).some(c => c.state === "connecting" || c.state === "waiting_scan");
	useEffect(() => {
		if (!pendingChannel || !rpc) return;
		const timer = window.setInterval(() => void refreshChannels(), 2000);
		return () => window.clearInterval(timer);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [pendingChannel, rpc]);

	// Countdown clock for the pair code, bounded to the code's lifetime so an
	// idle dialog schedules no timers.
	useEffect(() => {
		if (pairCodeExpiresAt === null) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [pairCodeExpiresAt]);

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

	const copyViewLink = async (): Promise<void> => {
		const viewLink = info?.viewLink;
		if (!viewLink) return;
		try {
			await navigator.clipboard.writeText(viewLink);
			setCopiedView(true);
			setTimeout(() => setCopiedView(false), 1500);
		} catch {
			// clipboard unavailable
		}
	};

	const hosting = info?.hosting ?? false;
	/** Seconds until the live pair code dies; null when none was minted. */
	const pairSecondsLeft = pairCodeExpiresAt === null ? null : Math.max(0, Math.ceil((pairCodeExpiresAt - now) / 1000));
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
					{/* Who is watching right now — the only way to tell an idle share
					 * from one with a guest attached (and whether they may prompt). */}
					{hosting && (info?.participants?.length ?? 0) > 0 ? (
						<div className="mt-1 flex flex-wrap gap-1">
							{(info?.participants ?? []).map(p => (
								<span
									key={`${p.role}:${p.name}`}
									className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--color-text-muted)]"
								>
									{p.readOnly ? t("{name} (watch-only)", { name: p.name }) : p.name}
								</span>
							))}
						</div>
					) : null}
					{error && <div className="gui-collab-error">{error}</div>}
					{hosting && webLink ? (
						<>
							<div className="gui-collab-qr">
								<canvas ref={qrRef} />
							</div>
							<div className="gui-collab-actions">
								<button type="button" className="gui-btn" onClick={() => void refresh()}>
									<Icon name="refresh" className="h-3.5 w-3.5" />
									<span>{t("refresh")}</span>
								</button>
								<button type="button" className="gui-btn" onClick={() => void copyLink()}>
									<Icon name="external-link" className="h-3.5 w-3.5" />
									<span>{copied ? t("copied") : t("copy link")}</span>
								</button>
								{/* Watch-only links are minted alongside the write link; the
								 * pane never showed them, so read-only sharing was TUI-only. */}
								{info?.viewLink ? (
									<button type="button" className="gui-btn" onClick={() => void copyViewLink()}>
										<Icon name="eye" className="h-3.5 w-3.5" />
										<span>{copiedView ? t("copied") : t("copy watch-only link")}</span>
									</button>
								) : null}
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
									{pairSecondsLeft === null
										? t("enter the 6-digit code in MusePi Mobile (same network)")
										: pairSecondsLeft > 0
											? t("single use · expires in {seconds}s", { seconds: String(pairSecondsLeft) })
											: t("this code has expired — get a new one")}
								</span>
							</div>
						</>
					) : (
						<div className="gui-collab-idle">
							<Segmented
								className="gui-seg--compact"
								value={mode}
								options={SHARE_SCOPE_SEGMENTS}
								onChange={v => setMode(v)}
							/>
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
							// 启动层级（issue: 点启动不出二维码）：只有存在“必填”字段的渠道
							// 才需要先展开表单（保存并启动）；wechat 的 token 是可选的（空=
							// QR 登录），点启动直接连，二维码立刻出现。表单仍可经齿轮进入
							// （想预置 token 跳过扫码时用）。
							const needsForm = !!fields && fields.some(f => !f.optional);
							const qrUrl = typeof c.config?.qrUrl === "string" ? c.config.qrUrl : "";
							const waitingScan = c.state === "waiting_scan";
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
										{on ? (
											<div className="flex items-center gap-1">
												{/* 停止：仅断开连接（token 已持久化，再次启动直连），无需确认。 */}
												<button
													type="button"
													className="gui-btn gui-btn-sm"
													disabled={c.state === "connecting"}
													onClick={() => {
														void rpc
															?.request("channels.stop", { kind: c.kind })
															.then(() => refreshChannels())
															.catch(() => refreshChannels());
													}}
												>
													{t("stop")}
												</button>
												{/* 解绑：断开 + 清除凭证（下次要重新扫码），二次确认。 */}
												<button
													type="button"
													className="gui-btn gui-btn-sm"
													title={t("unlink")}
													onClick={() => void unlinkChannel(c.kind)}
												>
													<Icon name="link-unlink-m" className="h-3 w-3" />
													<span>{t("unlink")}</span>
												</button>
											</div>
										) : (
											<div className="flex items-center gap-1">
												<button
													type="button"
													className="gui-btn gui-btn-sm"
													onClick={() => {
														if (needsForm) {
															setExpandedKind(expandedKind === c.kind ? null : c.kind);
														} else {
															// 全字段可选（wechat QR 登录）或无已知表单（插件渠道）
															// — 直接用持久化配置启动，二维码立即出现。
															void startChannel(c.kind);
														}
													}}
												>
													{t("start")}
												</button>
												{fields && (
													<button
														type="button"
														className="gui-btn gui-btn-sm"
														title={t("configure channel")}
														aria-label={t("configure channel")}
														onClick={() => setExpandedKind(expandedKind === c.kind ? null : c.kind)}
													>
														<Icon name="settings-3" className="h-3 w-3" />
													</button>
												)}
											</div>
										)}
									</div>
									{/* QR login (issue #28): the backend exposes the WeChat login
									 *  QR via status().config.qrUrl while waiting for a scan —
									 *  render it inline so the user can actually scan it.
									 *  iLink returns raw base64 PNG → channelQrSrc wraps it.
									 *  Reveal = 条件区块动效规范 (expand/collapse animation). */}
									<Reveal open={waitingScan && !!qrUrl}>
										{qrUrl ? (
											<div className="gui-collab-channel-qr">
												<img src={channelQrSrc(qrUrl)} alt="WeChat login QR" />
												<span>{c.detail ?? t("scan the QR code")}</span>
											</div>
										) : null}
									</Reveal>
									{startErrors[c.kind] && <div className="gui-collab-error">{startErrors[c.kind]}</div>}
									<Reveal open={expandedKind === c.kind && !!fields}>
										{fields && (
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
													disabled={!fields.every(f => f.optional || (configDraft[f.key] ?? "").trim())}
													onClick={() => void saveConfig(c.kind)}
												>
													{t("save and start")}
												</button>
											</div>
										)}
									</Reveal>
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
