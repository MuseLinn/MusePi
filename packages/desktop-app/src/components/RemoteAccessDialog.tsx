import { Segmented, type SegmentedOption, t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { openExternalUrl } from "../lib/electron";
import { useConfirm } from "../lib/prompt-dialog";
import { channelStateText, isCloudflaredMissing } from "../lib/remote-access";
import type { RpcClient } from "../lib/rpc";
import { Icon } from "../vendor/oc-icons";
import { QrCode } from "../vendor/qrcode";
import { DialogFrame } from "./DialogFrame";
import { Reveal } from "./Reveal";

type ShareMode = "session" | "workspace" | "tunnel";

interface RemoteAccessGuest {
	name: string;
	role: string;
	readOnly: boolean;
}

interface RemoteAccessInfo {
	hosting: boolean;
	link?: string;
	webLink?: string;
	viewLink?: string;
	participants?: RemoteAccessGuest[];
}

interface ChannelInfo {
	kind: string;
	state: string;
	detail?: string;
	config: Record<string, unknown>;
}

interface ChannelPlugin {
	kind: string;
	label: string;
	origin: string;
	registered: boolean;
}

const CLOUDFLARED_INSTALL_URL =
	"https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";
const CHANNEL_NAMES: Record<string, string> = {
	discord: "Discord",
	wechat: "WeChat",
	telegram: "Telegram",
	feishu: "Feishu",
	lark: "Lark",
	"huawei-today": "Huawei Today",
};

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

/** iLink's qrcode_img_content is a URL to encode, not an image URL. */
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

export function RemoteAccessDialog({
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
	const [info, setInfo] = useState<RemoteAccessInfo | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const { confirm } = useConfirm();
	const qrRef = useRef<HTMLCanvasElement | null>(null);
	const [webLink, setWebLink] = useState<string | null>(null);
	const [mode, setMode] = useState<ShareMode>("session");
	const [pairCode, setPairCode] = useState<string | null>(null);
	const [pairCodeExpiresAt, setPairCodeExpiresAt] = useState<number | null>(null);
	const [now, setNow] = useState(() => Date.now());
	const [copiedView, setCopiedView] = useState(false);
	const [channels, setChannels] = useState<ChannelInfo[] | null>(null);
	const [channelsError, setChannelsError] = useState(false);
	const [expandedKind, setExpandedKind] = useState<string | null>(null);
	const [configDraft, setConfigDraft] = useState<Record<string, string>>({});
	const [startErrors, setStartErrors] = useState<Record<string, string>>({});
	const [busyChannel, setBusyChannel] = useState<string | null>(null);
	const [plugins, setPlugins] = useState<ChannelPlugin[] | null>(null);
	const [reloadingPlugins, setReloadingPlugins] = useState(false);

	const refreshChannels = useCallback(async (): Promise<void> => {
		if (!rpc) return;
		try {
			const list = await rpc.request<ChannelInfo[]>("channels.list", {});
			setChannels(list);
			setChannelsError(false);
		} catch {
			setChannelsError(true);
		}
	}, [rpc]);

	const refreshPlugins = useCallback(async (): Promise<void> => {
		if (!rpc) return;
		try {
			const list = await rpc.request<ChannelPlugin[]>("channels.plugins", {});
			setPlugins(list);
		} catch {
			setPlugins([]);
		}
	}, [rpc]);

	const refresh = useCallback(async (): Promise<void> => {
		if (!rpc) return;
		try {
			const st = await rpc.request<RemoteAccessInfo>("remote-access.status", {
				...(sessionId !== null ? { sessionId } : {}),
			});
			setInfo(st);
			if (st.hosting && st.webLink) setWebLink(st.webLink);
		} catch {
			setInfo({ hosting: false });
		}
	}, [rpc, sessionId]);

	useEffect(() => {
		if (!open) return;
		void refresh();
		void refreshChannels();
		void refreshPlugins();
	}, [open, refresh, refreshChannels, refreshPlugins]);

	useEffect(() => {
		if (webLink && qrRef.current) drawQr(qrRef.current, webLink);
	}, [webLink]);

	const pendingChannel = (channels ?? []).some(c => c.state === "connecting" || c.state === "waiting_scan");
	useEffect(() => {
		if (!open || !pendingChannel || !rpc) return;
		const timer = window.setInterval(() => void refreshChannels(), 2000);
		return () => window.clearInterval(timer);
	}, [open, pendingChannel, rpc, refreshChannels]);

	useEffect(() => {
		if (pairCodeExpiresAt === null) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [pairCodeExpiresAt]);

	const reloadPlugins = async (): Promise<void> => {
		if (!rpc || reloadingPlugins) return;
		setReloadingPlugins(true);
		try {
			await rpc.request("channels.reloadPlugins", {});
			await Promise.all([refreshChannels(), refreshPlugins()]);
		} finally {
			setReloadingPlugins(false);
		}
	};

	const toggleConfig = (kind: string): void => {
		if (expandedKind !== kind) setConfigDraft({});
		setExpandedKind(expandedKind === kind ? null : kind);
		setStartErrors(errors => ({ ...errors, [kind]: "" }));
	};

	const saveConfig = async (kind: string): Promise<void> => {
		if (!rpc || busyChannel) return;
		setBusyChannel(kind);
		setStartErrors(errors => ({ ...errors, [kind]: "" }));
		try {
			await rpc.request("channels.configure", { kind, config: configDraft });
			await rpc.request("channels.start", { kind });
			setExpandedKind(null);
			setConfigDraft({});
		} catch (err) {
			setStartErrors(errors => ({ ...errors, [kind]: err instanceof Error ? err.message : String(err) }));
		} finally {
			await refreshChannels();
			setBusyChannel(null);
		}
	};

	const startChannel = async (kind: string): Promise<void> => {
		if (!rpc || busyChannel) return;
		setBusyChannel(kind);
		setStartErrors(errors => ({ ...errors, [kind]: "" }));
		try {
			await rpc.request("channels.start", { kind });
		} catch (err) {
			setStartErrors(errors => ({ ...errors, [kind]: err instanceof Error ? err.message : String(err) }));
		} finally {
			await refreshChannels();
			setBusyChannel(null);
		}
	};

	const stopChannel = async (kind: string): Promise<void> => {
		if (!rpc || busyChannel) return;
		setBusyChannel(kind);
		try {
			await rpc.request("channels.stop", { kind });
		} catch (err) {
			setStartErrors(errors => ({ ...errors, [kind]: err instanceof Error ? err.message : String(err) }));
		} finally {
			await refreshChannels();
			setBusyChannel(null);
		}
	};

	const unlinkChannel = async (kind: string): Promise<void> => {
		if (!rpc || busyChannel) return;
		const ok = await confirm(t("settings.unlinkChannelConfirm"), t("settings.unlink"), { destructive: true });
		if (!ok) return;
		setBusyChannel(kind);
		try {
			await rpc.request("channels.unlink", { kind });
		} catch (err) {
			setStartErrors(errors => ({ ...errors, [kind]: err instanceof Error ? err.message : String(err) }));
		} finally {
			await refreshChannels();
			setBusyChannel(null);
		}
	};

	const genPairCode = async (): Promise<void> => {
		if (!rpc) return;
		try {
			const res = await rpc.request<{ code: string; expiresInSeconds: number }>("remote-access.pair.generate", {});
			setPairCode(res.code);
			setPairCodeExpiresAt(Date.now() + res.expiresInSeconds * 1000);
			setNow(Date.now());
		} catch {
			setPairCode(null);
			setPairCodeExpiresAt(null);
		}
	};

	const startShare = async (): Promise<void> => {
		if (!rpc || busy || (mode === "session" && !sessionId)) return;
		setBusy(true);
		setError(null);
		try {
			const res = await rpc.request<RemoteAccessInfo>("remote-access.start", {
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
		if (!rpc || busy) return;
		setBusy(true);
		try {
			await rpc.request("remote-access.stop", {
				...(sessionId !== null ? { sessionId } : {}),
			});
			setInfo({ hosting: false });
			setWebLink(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const copyLink = async (): Promise<void> => {
		if (!webLink) return;
		try {
			await navigator.clipboard.writeText(webLink);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {}
	};

	const copyViewLink = async (): Promise<void> => {
		const viewLink = info?.viewLink;
		if (!viewLink) return;
		try {
			await navigator.clipboard.writeText(viewLink);
			setCopiedView(true);
			setTimeout(() => setCopiedView(false), 1500);
		} catch {}
	};

	const channelFields: Record<string, { key: string; label: string; secret: boolean; optional?: boolean }[]> = {
		discord: [{ key: "token", label: t("Bot token"), secret: true }],
		wechat: [{ key: "token", label: t("Token (optional — QR login if empty)"), secret: true, optional: true }],
		"huawei-today": [
			{ key: "apiKey", label: t("PERSONAL-API-KEY"), secret: true },
			{ key: "uid", label: t("PERSONAL-UID"), secret: false },
		],
		telegram: [{ key: "token", label: t("Bot token (from @BotFather)"), secret: true }],
		feishu: [
			{ key: "appId", label: t("App ID"), secret: false },
			{ key: "appSecret", label: t("App Secret"), secret: true },
		],
		lark: [
			{ key: "appId", label: t("App ID"), secret: false },
			{ key: "appSecret", label: t("App Secret"), secret: true },
		],
	};
	const shareScopeSegments: SegmentedOption<ShareMode>[] = [
		{ value: "session", label: t("general.currentSession") },
		{ value: "workspace", label: t("tools.workspace") },
		{ value: "tunnel", label: t("settings.publicTunnel") },
	];
	const hosting = info?.hosting ?? false;
	const pairSecondsLeft = pairCodeExpiresAt === null ? null : Math.max(0, Math.ceil((pairCodeExpiresAt - now) / 1000));
	const canShare = !busy && rpc !== null && (mode === "workspace" || mode === "tunnel" || sessionId !== null);
	const sessionHint =
		sessionId !== null && sessionTitle
			? t(`share session "{title}" live on the local network`, { title: sessionTitle })
			: t("settings.shareSessionLiveLocal");
	const scopeHint =
		sessionId === null && mode === "session"
			? t("settings.openCreateSessionFirst")
			: mode === "workspace"
				? t("general.shareWholeWorkspaceGuests")
				: mode === "tunnel"
					? t("settings.publicTunnelAnyone.info")
					: sessionHint;
	const tunnelMissing = error !== null && isCloudflaredMissing(error);

	return (
		<DialogFrame
			open={open}
			onClose={onClose}
			label={t("settings.mobileRemoteControl")}
			className="gui-collab-dialog"
		>
			<div className="gui-dialog-head">
				<h1 className="gui-collab-dialog-title">{t("settings.mobileRemoteControl")}</h1>
				<button type="button" className="gui-tool-btn" onClick={onClose} aria-label={t("settings.close")}>
					<Icon name="close" className="h-4 w-4" />
				</button>
			</div>
			<div className="gui-collab-grid">
				<section className="gui-collab-col gui-collab-share">
					<div className="gui-collab-col-head">
						<Icon name="smartphone" className="h-4 w-4" />
						<h2>{t("settings.scanConnect")}</h2>
					</div>
					<p className="gui-collab-desc">{t("settings.scanYourPhoneCamera")}</p>
					{hosting && webLink ? (
						<div className="gui-collab-hosting">
							<div className="gui-collab-status">
								<span className="gui-collab-dot" aria-hidden="true" />
								<span>{t("settings.waitingPhoneConnection")}</span>
								<button
									type="button"
									className="gui-btn gui-btn-stop gui-collab-stop"
									disabled={busy}
									onClick={() => void stopShare()}
								>
									<Icon name="stop" className="h-3 w-3" />
									<span>{t("settings.stopSharing")}</span>
								</button>
							</div>
							{(info?.participants?.length ?? 0) > 0 ? (
								<div className="gui-collab-participants">
									{(info?.participants ?? []).map(p => (
										<span key={`${p.role}:${p.name}`}>
											{p.readOnly ? t("settings.text", { name: p.name }) : p.name}
										</span>
									))}
								</div>
							) : null}
							{error ? (
								<div className="gui-collab-error" role="alert">
									<Icon name="error-warning" className="h-4 w-4" />
									<span>{error}</span>
								</div>
							) : null}
							<div className="gui-collab-qr">
								<canvas ref={qrRef} aria-label={t("settings.scanQrCode")} />
							</div>
							<div className="gui-collab-actions">
								<button type="button" className="gui-btn" onClick={() => void refresh()}>
									<Icon name="refresh" className="h-3.5 w-3.5" />
									<span>{t("settings.refresh")}</span>
								</button>
								<button type="button" className="gui-btn" onClick={() => void copyLink()}>
									<Icon name={copied ? "check" : "file-copy"} className="h-3.5 w-3.5" />
									<span aria-live="polite">{copied ? t("settings.copied") : t("settings.copyLink")}</span>
								</button>
								{info?.viewLink ? (
									<button type="button" className="gui-btn" onClick={() => void copyViewLink()}>
										<Icon name="eye" className="h-3.5 w-3.5" />
										<span aria-live="polite">
											{copiedView ? t("settings.copied") : t("settings.copyWatchOnlyLink")}
										</span>
									</button>
								) : null}
							</div>
							<div className="gui-collab-pair">
								<span className="gui-collab-pair-title">{t("settings.useMusepiMobilePair")}</span>
								<div className="gui-collab-pair-row">
									<span className="gui-collab-pair-code">{pairCode ?? "——————"}</span>
									<button type="button" className="gui-btn" onClick={() => void genPairCode()}>
										<Icon name="refresh" className="h-3.5 w-3.5" />
										<span>{t("settings.getCode")}</span>
									</button>
								</div>
								<span className="gui-collab-pair-hint">
									{pairSecondsLeft === null
										? t("settings.enter6DigitCodeMusepiMobile")
										: pairSecondsLeft > 0
											? t("settings.singleUseExpiresSWithSeconds", { seconds: String(pairSecondsLeft) })
											: t("settings.codeHasExpiredGet")}
								</span>
							</div>
						</div>
					) : (
						<div className="gui-collab-setup">
							<Segmented
								className="gui-collab-scope"
								value={mode}
								options={shareScopeSegments}
								ariaLabel={t("settings.shareScope")}
								disabled={busy}
								onChange={next => {
									setMode(next);
									setError(null);
								}}
							/>
							<div className="gui-collab-scope-summary">
								<Icon name={mode === "tunnel" ? "error-warning" : "information"} className="h-4 w-4" />
								<div>
									<h3>{shareScopeSegments.find(option => option.value === mode)?.label}</h3>
									<p>{scopeHint}</p>
								</div>
							</div>
							{tunnelMissing ? (
								<div className="gui-collab-recovery" role="alert">
									<Icon name="error-warning" className="h-5 w-5" />
									<div className="gui-collab-recovery-content">
										<h3>{t("settings.cloudflaredRequired")}</h3>
										<p>{t("settings.cloudflaredRequiredHint")}</p>
										<div className="gui-collab-recovery-actions">
											<button
												type="button"
												className="gui-btn"
												onClick={() => void openExternalUrl(CLOUDFLARED_INSTALL_URL)}
											>
												<Icon name="external-link" className="h-3.5 w-3.5" />
												<span>{t("settings.viewInstallGuide")}</span>
											</button>
											<button
												type="button"
												className="gui-btn gui-btn-primary"
												disabled={!canShare}
												onClick={() => void startShare()}
											>
												<Icon name="refresh" className="h-3.5 w-3.5" />
												<span>{busy ? t("settings.starting") : t("settings.retry")}</span>
											</button>
										</div>
										<details className="gui-collab-technical">
											<summary>{t("settings.technicalDetails")}</summary>
											<pre>{error}</pre>
										</details>
									</div>
								</div>
							) : (
								<>
									{error ? (
										<div className="gui-collab-error" role="alert">
											<Icon name="error-warning" className="h-4 w-4" />
											<span>{error}</span>
										</div>
									) : null}
									<button
										type="button"
										className="gui-btn gui-btn-primary gui-collab-start"
										disabled={!canShare}
										onClick={() => void startShare()}
									>
										<Icon name="send-plane" className="h-3.5 w-3.5" />
										<span>
											{busy
												? t("settings.starting")
												: error
													? t("settings.retry")
													: t("settings.startSharing")}
										</span>
									</button>
								</>
							)}
						</div>
					)}
				</section>
				<section className="gui-collab-col gui-collab-channel-col">
					<div className="gui-collab-col-head">
						<Icon name="robot" className="h-4 w-4" />
						<h2>{t("settings.useBotChannel")}</h2>
					</div>
					<p className="gui-collab-desc">{t("settings.connectChatBotLonger")}</p>
					<div className="gui-collab-channels">
						{channelsError ? (
							<div className="gui-collab-channel-message" role="alert">
								<Icon name="error-warning" className="h-4 w-4" />
								<div>
									<strong>{t("settings.channelsLoadFailed")}</strong>
									<p>{t("settings.channelsLoadFailedHint")}</p>
									<button type="button" className="gui-btn gui-btn-sm" onClick={() => void refreshChannels()}>
										<Icon name="refresh" className="h-3 w-3" />
										<span>{t("settings.retry")}</span>
									</button>
								</div>
							</div>
						) : channels === null ? (
							<div className="gui-collab-loading">
								<Icon name="loader" className="h-3.5 w-3.5 animate-spin" />
								<span>{t("settings.loadingChannels")}</span>
							</div>
						) : channels.length === 0 ? (
							<div className="gui-collab-loading">{t("settings.noChannelsConfigured")}</div>
						) : (
							<ul className="gui-collab-bots">
								{channels.map(c => {
									const label =
										plugins?.find(plugin => plugin.kind === c.kind)?.label ?? CHANNEL_NAMES[c.kind] ?? c.kind;
									const on = c.state === "connected" || c.state === "connecting" || c.state === "waiting_scan";
									const fields = channelFields[c.kind];
									const needsForm = !!fields && fields.some(field => !field.optional);
									const qrUrl = typeof c.config?.qrUrl === "string" ? c.config.qrUrl : "";
									const waitingScan = c.state === "waiting_scan";
									const channelBusy = busyChannel === c.kind;
									const stateKind = channelStateText(c.state, c.detail);
									const stateText =
										stateKind === "connected"
											? (c.detail ?? t("settings.connected"))
											: stateKind === "connecting"
												? (c.detail ?? t("settings.connecting"))
												: stateKind === "waiting"
													? (c.detail ?? t("settings.waitingForScan"))
													: stateKind === "detail"
														? c.detail
														: null;
									return (
										<li key={c.kind} className="gui-collab-bot-wrap">
											<div className="gui-collab-bot">
												<span
													className={`gui-collab-bot-ico gui-collab-bot-ico--${c.kind}`}
													aria-hidden="true"
												>
													{channelLogo(c.kind)}
												</span>
												<div className="gui-collab-bot-copy">
													<div className="gui-collab-bot-title">
														<span>{label}</span>
														<span
															className={`gui-collab-dot${on ? "" : " gui-collab-dot--off"}`}
															aria-hidden="true"
														/>
													</div>
													{stateText ? <div className="gui-collab-bot-status">{stateText}</div> : null}
												</div>
												{on ? (
													<div className="gui-collab-bot-actions">
														<button
															type="button"
															className="gui-btn gui-btn-sm"
															disabled={channelBusy || c.state === "connecting"}
															aria-label={t("settings.stopChannelWithName", { name: label })}
															onClick={() => void stopChannel(c.kind)}
														>
															{channelBusy ? t("settings.stopping") : t("settings.stop")}
														</button>
														<button
															type="button"
															className="gui-btn gui-btn-sm gui-collab-icon-action"
															title={t("settings.unlinkChannelWithName", { name: label })}
															aria-label={t("settings.unlinkChannelWithName", { name: label })}
															disabled={channelBusy}
															onClick={() => void unlinkChannel(c.kind)}
														>
															<Icon name="link-unlink-m" className="h-3.5 w-3.5" />
														</button>
													</div>
												) : (
													<div className="gui-collab-bot-actions">
														<button
															type="button"
															className="gui-btn gui-btn-sm"
															disabled={channelBusy}
															aria-label={t("settings.connectChannelWithName", { name: label })}
															onClick={() => {
																if (needsForm) toggleConfig(c.kind);
																else void startChannel(c.kind);
															}}
														>
															{channelBusy ? t("settings.connecting") : t("settings.connect")}
														</button>
														{fields ? (
															<button
																type="button"
																className="gui-btn gui-btn-sm gui-collab-icon-action"
																title={t("settings.configureChannelWithName", { name: label })}
																aria-label={t("settings.configureChannelWithName", { name: label })}
																aria-expanded={expandedKind === c.kind}
																onClick={() => toggleConfig(c.kind)}
															>
																<Icon name="settings-3" className="h-3.5 w-3.5" />
															</button>
														) : null}
													</div>
												)}
											</div>
											<Reveal open={waitingScan && !!qrUrl}>
												{qrUrl ? (
													<div className="gui-collab-channel-qr">
														<img src={channelQrSrc(qrUrl)} alt={t("WeChat login QR")} />
														<span>{c.detail ?? t("settings.scanQrCode")}</span>
													</div>
												) : null}
											</Reveal>
											{startErrors[c.kind] ? (
												<div className="gui-collab-error" role="alert">
													<Icon name="error-warning" className="h-4 w-4" />
													<span>{startErrors[c.kind]}</span>
												</div>
											) : null}
											<Reveal open={expandedKind === c.kind && !!fields}>
												{fields ? (
													<div className="gui-collab-channel-config">
														{fields.map(field => (
															<label key={field.key} className="gui-collab-channel-field">
																<span>{field.label}</span>
																<input
																	className="gui-collab-channel-input"
																	type={field.secret ? "password" : "text"}
																	aria-label={field.label}
																	required={!field.optional}
																	value={configDraft[field.key] ?? ""}
																	onChange={event =>
																		setConfigDraft(draft => ({
																			...draft,
																			[field.key]: event.target.value,
																		}))
																	}
																	autoComplete="off"
																/>
															</label>
														))}
														<button
															type="button"
															className="gui-btn gui-btn-primary gui-btn-sm"
															disabled={
																channelBusy ||
																!fields.every(
																	field => field.optional || (configDraft[field.key] ?? "").trim(),
																)
															}
															onClick={() => void saveConfig(c.kind)}
														>
															{channelBusy ? t("settings.connecting") : t("settings.saveStart")}
														</button>
													</div>
												) : null}
											</Reveal>
										</li>
									);
								})}
							</ul>
						)}
					</div>
					<details className="gui-collab-plugins">
						<summary>
							<span>{t("settings.channelPlugins")}</span>
							<span className="gui-collab-plugin-count">{plugins?.length ?? 0}</span>
						</summary>
						<div className="gui-collab-plugin-body">
							<button
								type="button"
								className="gui-btn gui-btn-sm"
								disabled={reloadingPlugins}
								onClick={() => void reloadPlugins().catch(() => {})}
							>
								<Icon name="refresh" className={`h-3 w-3${reloadingPlugins ? " animate-spin" : ""}`} />
								<span>{reloadingPlugins ? t("settings.loading") : t("settings.reloadPlugins")}</span>
							</button>
							<div className="gui-collab-plugin-list">
								{(plugins ?? []).map(plugin => (
									<span key={plugin.kind} title={plugin.origin}>
										{plugin.label}
									</span>
								))}
								{(plugins ?? []).length === 0 ? (
									<span className="gui-collab-no-plugins">{t("settings.noPlugins")}</span>
								) : null}
							</div>
						</div>
					</details>
				</section>
			</div>
		</DialogFrame>
	);
}
