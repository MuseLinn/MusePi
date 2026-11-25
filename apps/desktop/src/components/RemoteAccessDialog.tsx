import { fmtDuration, t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { openExternalUrl } from "../lib/electron";
import { useConfirm } from "../lib/prompt-dialog";
import { channelStateText } from "../lib/remote-access";
import type { RpcClient } from "../lib/rpc";
import { useScrollShadow } from "../lib/use-scroll-shadow";
import { Icon } from "../vendor/oc-icons";
import { QrCode } from "../vendor/qrcode";
import { DialogFrame } from "./DialogFrame";
import { Reveal } from "./Reveal";
import { ScrollEdgeBlur } from "./ScrollEdgeBlur";

type ShareScope = "workspace" | "session";
type ExposureHealth = "unavailable" | "starting" | "ready" | "degraded" | "stopped";

interface RemoteAccessGuest {
	name: string;
	role: string;
	readOnly: boolean;
}

interface ShareEnd {
	exposure: string;
	health: ExposureHealth;
	at: string;
	reason: string;
	detail?: string;
	hint?: string;
}

interface RemoteAccessInfo {
	hosting: boolean;
	mode?: ShareScope;
	sessionId?: string | null;
	exposure?: string;
	/** Live exposure status from the daemon; `degraded` invalidates the link. */
	health?: { health: ExposureHealth; detail?: string } | null;
	link?: string;
	webLink?: string;
	viewLink?: string;
	participants?: RemoteAccessGuest[];
	/** Wall-clock end of a time-limited share; absent when it runs until stopped. */
	expiresAt?: number;
	lastEnd?: ShareEnd;
	/** A configuration value made part of the share unusable (e.g. collab.webUrl). */
	warning?: string;
}

interface ExposureCapabilities {
	guestInstall: boolean;
	publicExposure: boolean;
	stableUrl: boolean;
	thirdParty: boolean;
}

interface ExposureInstallHint {
	url: string;
	commands: Partial<Record<string, string>>;
	note?: string;
}

interface ExposureOption {
	id: string;
	label: string;
	health: ExposureHealth;
	detail?: string;
	hint?: string;
	install?: ExposureInstallHint;
	capabilities?: ExposureCapabilities;
}

interface ExposuresInfo {
	default: string;
	exposures: ExposureOption[];
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

const CHANNEL_NAMES: Record<string, string> = {
	discord: "Discord",
	wechat: "WeChat",
	telegram: "Telegram",
	feishu: "Feishu",
	lark: "Lark",
	"huawei-today": "Huawei Today",
};

const PLATFORM_NAMES: Record<string, string> = {
	darwin: "macOS",
	linux: "Linux",
	win32: "Windows",
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
	initialScope = "workspace",
	open,
	onClose,
	onOpenDisclaimer,
}: {
	rpc: RpcClient | null;
	sessionId: string | null;
	sessionTitle: string | null;
	/** Scope this entrance belongs to: the session menu shares one session, the environment rail the workspace. */
	initialScope?: ShareScope;
	open: boolean;
	onClose(): void;
	onOpenDisclaimer(): void;
}): ReactNode {
	const [info, setInfo] = useState<RemoteAccessInfo | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [errorAction, setErrorAction] = useState<"start" | "pair" | "stop">("start");
	const [copied, setCopied] = useState(false);
	const { confirm } = useConfirm();
	const qrRef = useRef<HTMLCanvasElement | null>(null);
	const [webLink, setWebLink] = useState<string | null>(null);
	const [exposures, setExposures] = useState<ExposureOption[] | null>(null);
	const [exposureId, setExposureId] = useState<string | null>(null);
	const [exposuresError, setExposuresError] = useState(false);
	const [exposuresLoading, setExposuresLoading] = useState(false);
	const [pairCode, setPairCode] = useState<string | null>(null);
	const [pairHost, setPairHost] = useState<string | null>(null);
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
			const st = await rpc.request<RemoteAccessInfo>("remote-access.status", {});
			setInfo(st);
			// A degraded exposure has already lost its link; showing the old QR
			// would invite guests into a dead room until the teardown lands.
			const live = st.hosting && st.health?.health !== "degraded";
			setWebLink(live && st.webLink ? st.webLink : null);
		} catch {
			setInfo({ hosting: false });
			setWebLink(null);
		}
	}, [rpc]);

	const refreshExposures = useCallback(async (): Promise<void> => {
		if (!rpc) return;
		setExposuresLoading(true);
		try {
			const res = await rpc.request<ExposuresInfo>("collab.exposures", {});
			setExposures(res.exposures);
			setExposuresError(false);
			setExposureId(current => {
				if (current && res.exposures.some(entry => entry.id === current)) return current;
				const preferred =
					res.exposures.find(entry => entry.id === res.default && entry.health !== "unavailable") ??
					res.exposures.find(entry => entry.health === "ready") ??
					res.exposures.find(entry => entry.id === "lan") ??
					res.exposures[0];
				return preferred?.id ?? null;
			});
		} catch {
			setExposuresError(true);
		} finally {
			setExposuresLoading(false);
		}
	}, [rpc]);

	useEffect(() => {
		if (!open) return;
		// Drop the previous visit's answer before the first status round-trip:
		// a share that ended while the panel was closed must not flash its old
		// QR or link for a frame.
		setInfo(null);
		setWebLink(null);
		setError(null);
		setErrorAction("start");
		setPairCode(null);
		setPairHost(null);
		setPairCodeExpiresAt(null);
		void refresh();
		void refreshExposures();
		void refreshChannels();
		void refreshPlugins();
	}, [open, initialScope, refresh, refreshExposures, refreshChannels, refreshPlugins]);

	useEffect(() => {
		if (webLink && qrRef.current) drawQr(qrRef.current, webLink);
	}, [webLink]);

	// The share panel is the only place that answers "did the phone connect?".
	// The status RPC is cheap; polling only while this dialog is open and
	// hosting keeps an idle share honest without a background timer.
	useEffect(() => {
		if (!open || info?.hosting !== true || !rpc) return;
		const timer = window.setInterval(() => void refresh(), 3000);
		return () => window.clearInterval(timer);
	}, [open, info?.hosting, rpc, refresh]);

	const pendingChannel = (channels ?? []).some(c => c.state === "connecting" || c.state === "waiting_scan");
	useEffect(() => {
		if (!open || !pendingChannel || !rpc) return;
		const timer = window.setInterval(() => void refreshChannels(), 2000);
		return () => window.clearInterval(timer);
	}, [open, pendingChannel, rpc, refreshChannels]);

	const shareExpiresAt = info?.hosting === true ? (info.expiresAt ?? null) : null;
	useEffect(() => {
		// One ticker for every countdown the panel shows (pair code, share TTL);
		// both are wall-clock deadlines, so a single second step keeps them live.
		if (pairCodeExpiresAt === null && shareExpiresAt === null) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [pairCodeExpiresAt, shareExpiresAt]);

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
			const res = await rpc.request<{ code: string; expiresInSeconds: number; lanHost?: string | null }>(
				"remote-access.pair.generate",
				{},
			);
			setPairCode(res.code);
			setPairHost(res.lanHost ?? null);
			setPairCodeExpiresAt(Date.now() + res.expiresInSeconds * 1000);
			setNow(Date.now());
		} catch (err) {
			// A code the phone cannot resolve is worse than no code: say why the
			// LAN endpoint is unavailable instead of leaving an empty slot.
			setPairCode(null);
			setPairHost(null);
			setPairCodeExpiresAt(null);
			setErrorAction("pair");
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const startShare = async (): Promise<void> => {
		if (!rpc || busy || exposureId === null || (initialScope === "session" && !sessionId)) return;
		setBusy(true);
		setError(null);
		try {
			const res = await rpc.request<RemoteAccessInfo>("remote-access.start", {
				mode: initialScope,
				exposure: exposureId,
				...(initialScope === "session" && sessionId !== null ? { sessionId } : {}),
			});
			setInfo({ ...res, hosting: true });
			setWebLink(res.webLink ?? null);
			// A code minted for the previous share was cleared server-side.
			setPairCode(null);
			setPairHost(null);
			setPairCodeExpiresAt(null);
		} catch (err) {
			setErrorAction("start");
			setError(err instanceof Error ? err.message : String(err));
			// A start failure often means the transport's prerequisite vanished
			// after the probe; re-probe so its install card appears.
			void refreshExposures();
		} finally {
			setBusy(false);
		}
	};

	const stopShare = async (): Promise<void> => {
		if (!rpc || busy) return;
		setBusy(true);
		try {
			await rpc.request("remote-access.stop", {});
			await refresh();
			setPairCode(null);
			setPairHost(null);
			setPairCodeExpiresAt(null);
		} catch (err) {
			setErrorAction("stop");
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

	const exposureName = (id: string | null | undefined): string => {
		const found = id ? exposures?.find(entry => entry.id === id) : undefined;
		if (!found) return id ?? "";
		return found.id === "lan" ? t("settings.exposureLan") : found.label;
	};
	const healthText = (health: ExposureHealth): string => {
		switch (health) {
			case "ready":
				return t("settings.exposureHealthReady");
			case "starting":
				return t("settings.exposureHealthStarting");
			case "unavailable":
				return t("settings.exposureHealthUnavailable");
			case "degraded":
				return t("settings.exposureHealthDegraded");
			default:
				return t("settings.exposureHealthStopped");
		}
	};
	const shareEndReason = (end: ShareEnd): string => {
		switch (end.reason) {
			case "exposure degraded":
				return t("settings.shareEndedExposureDegraded");
			case "session switched":
				return t("settings.shareEndedSessionSwitched");
			case "share time limit reached":
				return t("settings.shareEndedTimeLimit");
			case "stopped from gui":
				return t("settings.shareEndedStopped");
			case "previous share ended":
			case "restarting share with a different scope":
				return t("settings.shareEndedRestarted");
			case "share already ended":
				return t("settings.shareEndedGeneric");
			default:
				return end.reason || t("settings.shareEndedGeneric");
		}
	};

	const liveHealth = info?.health?.health;
	const live = info?.hosting === true && liveHealth !== "degraded";
	const degraded = info?.hosting === true && liveHealth === "degraded";
	const currentExposureId = live ? (info?.exposure ?? exposureId) : exposureId;
	const selectedExposure = exposures?.find(entry => entry.id === exposureId) ?? null;
	const exposureAvailable = selectedExposure !== null && selectedExposure.health !== "unavailable";
	const hostingScope = info?.mode ?? initialScope;
	const pairSecondsLeft = pairCodeExpiresAt === null ? null : Math.max(0, Math.ceil((pairCodeExpiresAt - now) / 1000));
	const shareSecondsLeft = shareExpiresAt === null ? null : Math.max(0, Math.ceil((shareExpiresAt - now) / 1000));
	const canShare =
		!busy &&
		rpc !== null &&
		!exposuresError &&
		exposureAvailable &&
		(initialScope === "workspace" || sessionId !== null);
	const canRetry =
		!busy && rpc !== null && (errorAction !== "start" || initialScope === "workspace" || sessionId !== null);
	const retryError = (): void => {
		if (errorAction === "pair") void genPairCode();
		else if (errorAction === "stop") void stopShare();
		else void startShare();
	};
	const scopeHint =
		initialScope === "session"
			? sessionId !== null
				? t("settings.shareSessionScopeHint", { title: sessionTitle ?? t("general.currentSession") })
				: t("settings.openCreateSessionFirst")
			: t("general.shareWholeWorkspaceGuests");
	// Who can reach this share and who carries the traffic are the facts that
	// separate the four paths; a probe already reports them, so the option
	// states them instead of leaving the choice to the names alone.
	const exposureFacts = (entry: ExposureOption): string[] => {
		const caps = entry.capabilities;
		if (!caps) return [];
		const facts = [caps.publicExposure ? t("settings.exposurePublic") : t("settings.exposureLanOnly")];
		if (caps.thirdParty) facts.push(t("settings.exposureThirdParty"));
		if (caps.guestInstall) facts.push(t("settings.exposureGuestInstall"));
		if (caps.stableUrl) facts.push(t("settings.exposureStableUrl"));
		return facts.slice(0, 2);
	};
	const titleIcon = initialScope === "session" ? "share-2" : "global";

	const scrollRef = useRef<HTMLDivElement | null>(null);
	useScrollShadow(scrollRef);

	const errorBlock = error ? (
		<div className="gui-collab-recovery" role="alert">
			<Icon name="error-warning" className="h-5 w-5" />
			<div className="gui-collab-recovery-content">
				<h3>{errorAction === "start" ? t("settings.shareStartFailed") : t("settings.shareActionFailed")}</h3>
				<p>{t("settings.shareFailedHint")}</p>
				<details className="gui-collab-technical">
					<summary>{t("settings.technicalDetails")}</summary>
					<pre>{error}</pre>
				</details>
			</div>
		</div>
	) : null;

	const warningBlock = info?.warning ? (
		<div className="gui-collab-scope-summary" role="status">
			<Icon name="information" className="h-4 w-4" />
			<div>
				<p>{t("settings.shareConfigWarning")}</p>
				<details className="gui-collab-technical">
					<summary>{t("settings.technicalDetails")}</summary>
					<pre>{info.warning}</pre>
				</details>
			</div>
		</div>
	) : null;

	return (
		<DialogFrame
			open={open}
			onClose={onClose}
			label={t("settings.mobileRemoteControl")}
			className="gui-collab-dialog"
		>
			<div className="gui-dialog-head">
				<h1 className="gui-collab-dialog-title flex items-center gap-2">
					<Icon name={titleIcon} className="h-4 w-4" />
					{t("settings.mobileRemoteControl")}
				</h1>
				<button type="button" className="gui-tool-btn" onClick={onClose} aria-label={t("settings.close")}>
					<Icon name="close" className="h-4 w-4" />
				</button>
			</div>
			<div className="gui-collab-frame gui-scroll-frame">
				<div ref={scrollRef} className="gui-collab-grid">
					<section className="gui-collab-col gui-collab-share">
						<div className="gui-collab-col-head">
							<h2>{t("settings.shareLink")}</h2>
						</div>
						{live ? (
							<div className="gui-collab-hosting">
								<div className="gui-collab-status">
									<span className="gui-collab-dot" aria-hidden="true" />
									<span>{t("settings.shareWaitingGuests")}</span>
									<span className="gui-collab-status-meta">
										{hostingScope === "workspace" ? t("tools.workspace") : t("general.currentSession")} ·{" "}
										{exposureName(currentExposureId)}
									</span>
									{shareSecondsLeft !== null && shareSecondsLeft > 0 ? (
										<span className="gui-collab-status-deadline">
											{t("settings.shareEndsIn", { time: fmtDuration(shareSecondsLeft * 1000) })}
										</span>
									) : null}
								</div>
								{(info?.participants?.length ?? 0) > 0 ? (
									<div className="gui-collab-participants">
										{(info?.participants ?? []).map(p => (
											<span key={`${p.role}:${p.name}`} className="gui-collab-participant">
												<span>{p.name}</span>
												<span className="gui-collab-participant-sep" aria-hidden="true">
													·
												</span>
												<span>
													{p.role === "host"
														? t("settings.participantHost")
														: t("settings.participantDevice")}
												</span>
												{p.readOnly ? (
													<span className="gui-collab-participant-lock">
														<Icon name="lock-2" className="h-3 w-3" aria-hidden="true" />
														{t("general.readOnly")}
													</span>
												) : null}
											</span>
										))}
									</div>
								) : null}
								{error ? errorBlock : null}
								{warningBlock}
								{webLink ? (
									<>
										<div className="gui-collab-qr">
											<canvas ref={qrRef} aria-label={t("settings.scanQrCode")} />
										</div>
										<div className="gui-collab-actions">
											<button
												type="button"
												className="gui-btn gui-btn-primary"
												onClick={() => void copyLink()}
											>
												<Icon name={copied ? "check" : "file-copy"} className="h-3.5 w-3.5" />
												<span aria-live="polite">
													{copied ? t("settings.copied") : t("settings.copyLink")}
												</span>
											</button>
											<button
												type="button"
												className="gui-btn"
												onClick={() => void openExternalUrl(webLink)}
											>
												<Icon name="external-link" className="h-3.5 w-3.5" />
												<span>{t("settings.openShareInBrowser")}</span>
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
										{currentExposureId === "lan" ? (
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
													{pairHost
														? t("settings.pairCodeWithAddress", { host: pairHost })
														: pairSecondsLeft === null
															? t("settings.enter6DigitCodeMusepiMobile")
															: pairSecondsLeft > 0
																? t("settings.singleUseExpiresSWithSeconds", {
																		seconds: String(pairSecondsLeft),
																	})
																: t("settings.codeHasExpiredGet")}
												</span>
											</div>
										) : (
											<div className="gui-collab-pair">
												<span className="gui-collab-pair-title">{t("settings.shareDirectLink")}</span>
												<code className="select-text break-all rounded-lg border border-[var(--border)] bg-[var(--color-surface-raised)] p-2 font-mono text-[11px] text-[var(--color-text-muted)]">
													{webLink}
												</code>
												<span className="gui-collab-pair-hint">{t("settings.shareDirectLinkHint")}</span>
											</div>
										)}
									</>
								) : null}
							</div>
						) : (
							<div className="gui-collab-setup">
								<p className="gui-collab-desc">{t("settings.remoteAccessIntro")}</p>
								{degraded ? (
									<div className="gui-collab-recovery" role="alert">
										<Icon name="error-warning" className="h-5 w-5" />
										<div className="gui-collab-recovery-content">
											<h3>{t("settings.shareDegraded")}</h3>
											<p>{t("settings.shareDegradedHint")}</p>
										</div>
									</div>
								) : null}
								{info?.lastEnd ? (
									<div className="gui-collab-scope-summary" role="status">
										<Icon name="information" className="h-4 w-4" />
										<div>
											<h3>{t("settings.shareEnded")}</h3>
											<p>{shareEndReason(info.lastEnd)}</p>
											<p>{info.lastEnd.hint ?? t("settings.shareEndedNextStep")}</p>
											{info.lastEnd.detail ? (
												<details className="gui-collab-technical">
													<summary>{t("settings.technicalDetails")}</summary>
													<pre>{info.lastEnd.detail}</pre>
												</details>
											) : null}
										</div>
									</div>
								) : null}
								{warningBlock}
								<p className="gui-collab-scope-line">{scopeHint}</p>
								<div className="gui-collab-exposures">
									<div className="gui-collab-group-head">
										<span>{t("settings.shareExposure")}</span>
										<button
											type="button"
											className="gui-tool-btn gui-collab-recheck"
											disabled={busy || exposuresLoading}
											aria-label={t("settings.recheckExposures")}
											title={t("settings.recheckExposures")}
											onClick={() => void refreshExposures()}
										>
											<Icon
												name="refresh"
												className={`h-3.5 w-3.5${exposuresLoading ? " animate-spin" : ""}`}
											/>
										</button>
									</div>
									{exposuresError ? (
										<div className="gui-collab-channel-message" role="alert">
											<Icon name="error-warning" className="h-4 w-4" />
											<div>
												<strong>{t("settings.exposuresLoadFailed")}</strong>
												<p>{t("settings.exposuresLoadFailedHint")}</p>
												<button
													type="button"
													className="gui-btn gui-btn-sm"
													onClick={() => void refreshExposures()}
												>
													<Icon name="refresh" className="h-3 w-3" />
													<span>{t("settings.retry")}</span>
												</button>
											</div>
										</div>
									) : exposures === null && exposuresLoading ? (
										<div className="gui-collab-loading">
											<Icon name="loader" className="h-3.5 w-3.5 animate-spin" />
											<span>{t("settings.loadingExposures")}</span>
										</div>
									) : (
										<div
											role="radiogroup"
											aria-label={t("settings.shareExposure")}
											className="gui-collab-exposure-list"
										>
											{(exposures ?? []).map(entry => {
												const selected = entry.id === exposureId;
												const ready = entry.health === "ready";
												const facts = exposureFacts(entry);
												return (
													<div
														key={entry.id}
														className="gui-collab-exposure"
														data-selected={selected ? "true" : "false"}
													>
														<button
															type="button"
															role="radio"
															aria-checked={selected}
															disabled={busy}
															onClick={() => {
																setExposureId(entry.id);
																setError(null);
															}}
															className="gui-collab-exposure-row"
														>
															<span
																className="gui-collab-radio"
																data-on={selected ? "true" : "false"}
																aria-hidden="true"
															>
																{selected ? <span /> : null}
															</span>
															<span className="gui-collab-exposure-copy">
																<span className="gui-collab-exposure-name">
																	{exposureName(entry.id)}
																</span>
																<span className="gui-collab-exposure-state">
																	<span
																		className={`gui-collab-dot${ready ? "" : " gui-collab-dot--off"}`}
																		aria-hidden="true"
																	/>
																	<span>{healthText(entry.health)}</span>
																	{facts.length > 0 ? (
																		<span className="gui-collab-exposure-facts">
																			{facts.join(" · ")}
																		</span>
																	) : null}
																</span>
															</span>
														</button>
														{entry.health === "unavailable" && entry.install ? (
															<details className="gui-collab-exposure-more">
																<summary>
																	{t("settings.exposureInstallTitle", {
																		name: exposureName(entry.id),
																	})}
																</summary>
																<div className="gui-collab-install-body">
																	<p>{t("settings.exposureInstallNote")}</p>
																	{entry.install?.note ? (
																		<p className="gui-collab-install-source">{entry.install.note}</p>
																	) : null}
																	{Object.entries(entry.install?.commands ?? {}).map(
																		([platform, command]) => (
																			<div key={platform} className="gui-collab-platform">
																				<span>{PLATFORM_NAMES[platform] ?? platform}</span>
																				<code>{command}</code>
																			</div>
																		),
																	)}
																	<button
																		type="button"
																		className="gui-btn gui-btn-sm"
																		onClick={() => void openExternalUrl(entry.install?.url ?? "")}
																	>
																		<Icon name="external-link" className="h-3 w-3" />
																		<span>{t("settings.viewInstallGuide")}</span>
																	</button>
																</div>
															</details>
														) : null}
													</div>
												);
											})}
										</div>
									)}
									{selectedExposure?.hint || selectedExposure?.detail ? (
										<details className="gui-collab-technical">
											<summary>{t("settings.technicalDetails")}</summary>
											{selectedExposure.hint ? <p>{selectedExposure.hint}</p> : null}
											{selectedExposure.detail ? <pre>{selectedExposure.detail}</pre> : null}
										</details>
									) : null}
								</div>
								{error ? errorBlock : null}
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
										<button
											type="button"
											className="gui-btn gui-btn-sm"
											onClick={() => void refreshChannels()}
										>
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
											plugins?.find(plugin => plugin.kind === c.kind)?.label ??
											CHANNEL_NAMES[c.kind] ??
											c.kind;
										const on =
											c.state === "connected" || c.state === "connecting" || c.state === "waiting_scan";
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
															: t("settings.notConnected");
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
															{c.state === "connected" ? (
																<span className="gui-collab-dot" aria-hidden="true" />
															) : null}
														</div>
														<div className="gui-collab-bot-status">{stateText}</div>
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
				<ScrollEdgeBlur edge="top" />
				<ScrollEdgeBlur edge="end" />
			</div>
			<div className="gui-collab-foot">
				<button type="button" className="gui-remote-disclaimer-link" onClick={onOpenDisclaimer}>
					{t("settings.viewRemoteDisclaimer")}
				</button>
				{live ? (
					<button
						type="button"
						className="gui-btn gui-btn-stop gui-collab-foot-action"
						disabled={busy}
						onClick={() => void stopShare()}
					>
						<Icon name="stop" className="h-3.5 w-3.5" />
						<span>{t("settings.stopSharing")}</span>
					</button>
				) : error ? (
					<button
						type="button"
						className="gui-btn gui-btn-primary gui-collab-foot-action"
						disabled={!canRetry}
						onClick={retryError}
					>
						<Icon name="refresh" className="h-3.5 w-3.5" />
						<span>{busy ? t("settings.starting") : t("settings.retry")}</span>
					</button>
				) : (
					<button
						type="button"
						className="gui-btn gui-btn-primary gui-collab-foot-action"
						disabled={!canShare}
						onClick={() => void startShare()}
					>
						<Icon name="send-plane" className="h-3.5 w-3.5" />
						<span>{busy ? t("settings.starting") : t("settings.startSharing")}</span>
					</button>
				)}
			</div>
		</DialogFrame>
	);
}
