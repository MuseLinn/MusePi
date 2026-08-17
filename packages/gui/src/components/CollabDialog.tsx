import { t } from "@musepi/collab-web";
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
	const [mode, setMode] = useState<"session" | "workspace">("session");

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
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [rpc, sessionId]);

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
	const canShare = !busy && rpc !== null && (mode === "workspace" || sessionId !== null);
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
											: sessionHint}
								</p>
							</div>
						)}
					</section>
					{/* Right: bot channels (placeholder — no bot backend). */}
					<section className="gui-collab-col">
						<div className="gui-collab-col-head">
							<Icon name="robot" className="h-4 w-4" />
							<span>{t("use bot channel")}</span>
						</div>
						<p className="gui-collab-desc">{t("connect a chat bot for longer mobile access")}</p>
						<div className="gui-collab-bots">
							{(["wechat", "feishu", "lark", "telegram"] as const).map(b => (
								<div key={b} className="gui-collab-bot gui-collab-bot--disabled" title={t("not configured")}>
									<span className={`gui-collab-bot-ico gui-collab-bot-ico--${b}`} />
									<div className="min-w-0 flex-1">
										<div className="text-[13px] font-medium capitalize">{b}</div>
										<div className="truncate text-[12px] text-[var(--color-text-faint)]">
											{t("open this workspace from {name}", { name: b })}
										</div>
									</div>
								</div>
							))}
						</div>
						<button type="button" className="gui-collab-bot-mgmt" disabled title={t("not configured")}>
							<Icon name="settings-3" className="h-3.5 w-3.5" />
							<span>{t("bot management")}</span>
						</button>
					</section>
				</div>
		</DialogFrame>
	);
}
