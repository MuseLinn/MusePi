/*
 * Voice first-use guide (快赢包 A3): the composer mic used to feed a bare
 * `stt.transcribe` RPC on first click — GB-scale model fetch inside the call,
 * which on mainland networks (huggingface.co unreachable, pre-A1) surfaced as
 * an opaque "request timeout". dsh's flow (0.1.7-rc.2 voice-input bundle) gates
 * first use behind an explicit "使用前需要安装" dialog with size/time notes and
 * a guided install; this is the liquid-glass equivalent.
 *
 * Flow: mic click → stt.modelStatus (defaultKey/defaultCached, A2) → cached
 * ⇒ proceed straight into dictation; missing ⇒ open this dialog (prompt:
 * model label + size hint + 稍后/前往安装) → 前往安装 fires stt.modelDownload
 * and the dialog switches to a live progress bar riding the same global
 * stt.download* events as the settings voice page → done closes the dialog and
 * auto-starts the dictation the user originally asked for; error offers 重试.
 *
 * Desktop-app only for now; guest-client parity is a follow-up (the wire
 * contract is shared, only this component is shell-local).
 */
import { t } from "@musepi/client-core";
import { isSttDownloadEvent, type SttModelStatusResponse } from "@musepi/pi-wire";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { RpcClient } from "../../lib/rpc";

/** Size hints mirror stt/models.ts `sizeHint` (local UI data; the wire row
 *  stays { key, label, cached }). Kept in sync with settings-sections/voice.tsx
 *  TIER_META — if a tier is added/renamed, update both. */
const SIZE_HINTS: Record<string, string> = {
	fast: "~60 MB",
	balanced: "~190 MB",
	turbo: "~600 MB",
	parakeet: "~680 MB",
};

interface SetupState {
	modelKey: string;
	label: string;
	size: string;
	phase: "prompt" | "downloading" | "error";
	percent: number;
	loaded: number;
	total: number;
	error: string | null;
}

function formatBytes(n: number): string {
	if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
	if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(0)} MB`;
	if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(0)} KB`;
	return `${n} B`;
}

export interface VoiceSetupGate {
	/** Composer mic entry point: gates dictation behind the first-use guide. */
	onToggle(): Promise<void>;
	/** Render next to the composer (null while the guide is closed). */
	dialog: ReactNode;
}

export function useVoiceSetupGate(opts: { rpc: RpcClient | null; onProceed(): void }): VoiceSetupGate {
	const { rpc, onProceed } = opts;
	const [setup, setSetup] = useState<SetupState | null>(null);
	// Ref mirrors: the event listener closes over the latest state without
	// re-subscribing per tick, and onProceed must stay the caller's CURRENT
	// closure (composer draft callbacks) even though the toggle arms once.
	const setupRef = useRef<SetupState | null>(null);
	setupRef.current = setup;
	const onProceedRef = useRef(onProceed);
	useEffect(() => {
		onProceedRef.current = onProceed;
	});

	// Global download events (same channel as the settings voice page): while
	// the guide is open, progress advances the bar and both terminal outcomes
	// settle it — done auto-starts the dictation, error flips to retry.
	useEffect(() => {
		if (!rpc) return;
		const off = rpc.addEventListener(event => {
			const p = event.payload;
			if (!isSttDownloadEvent(p)) return;
			const current = setupRef.current;
			if (!current || p.modelKey !== current.modelKey) return;
			if (p.type === "stt.downloadProgress") {
				setSetup({
					...current,
					phase: "downloading",
					percent: p.percent,
					loaded: p.loaded ?? 0,
					total: p.total ?? 0,
				});
				return;
			}
			if (p.type === "stt.downloadDone") {
				// Model on disk now — give the bar a beat to paint 100%, then
				// honor the mic click the dialog interrupted.
				setSetup({ ...current, phase: "downloading", percent: 100, loaded: current.total, total: current.total });
				window.setTimeout(() => {
					setSetup(null);
					onProceedRef.current();
				}, 450);
				return;
			}
			setSetup({ ...current, phase: "error", error: p.message ?? t("voice setup download failed") });
		});
		return off;
	}, [rpc]);

	const startDownload = useCallback(
		(modelKey: string): void => {
			setSetup(prev => (prev ? { ...prev, phase: "downloading", percent: 0, error: null } : prev));
			void rpc?.request("stt.modelDownload", { modelKey }).catch(err => {
				setSetup(prev =>
					prev ? { ...prev, phase: "error", error: err instanceof Error ? err.message : String(err) } : prev,
				);
			});
		},
		[rpc],
	);

	const onToggle = useCallback(async (): Promise<void> => {
		// Guide already open: swallow the mic click (the dialog owns the flow).
		if (setupRef.current) return;
		if (!rpc) {
			// No daemon connection — let dictation surface its own error copy.
			onProceedRef.current();
			return;
		}
		let status: SttModelStatusResponse;
		try {
			status = await rpc.request<SttModelStatusResponse>("stt.modelStatus", {});
		} catch {
			// Status unreadable (old daemon): fall through to dictation rather
			// than dead-locking the mic on a gate that cannot resolve.
			onProceedRef.current();
			return;
		}
		const defaultKey = status.defaultKey ?? status.models[0]?.key;
		if (!defaultKey) {
			onProceedRef.current();
			return;
		}
		const cached = status.models.find(m => m.key === defaultKey)?.cached ?? status.defaultCached ?? false;
		if (cached) {
			onProceedRef.current();
			return;
		}
		const downloading = status.downloads?.includes(defaultKey) ?? false;
		setSetup({
			modelKey: defaultKey,
			label: status.models.find(m => m.key === defaultKey)?.label ?? defaultKey,
			size: SIZE_HINTS[defaultKey] ?? "",
			phase: downloading ? "downloading" : "prompt",
			percent: 0,
			loaded: 0,
			total: 0,
			error: null,
		});
	}, [rpc]);

	const dialog = setup ? (
		<VoiceSetupDialog
			state={setup}
			onInstall={() => startDownload(setup.modelKey)}
			onRetry={() => startDownload(setup.modelKey)}
			onDismiss={() => setSetup(null)}
		/>
	) : null;

	return { onToggle, dialog };
}

function VoiceSetupDialog({
	state,
	onInstall,
	onRetry,
	onDismiss,
}: {
	state: SetupState;
	onInstall(): void;
	onRetry(): void;
	onDismiss(): void;
}) {
	const [dismissing, setDismissing] = useState(false);
	const close = (): void => {
		setDismissing(true);
		window.setTimeout(onDismiss, 150);
	};
	const progressText =
		state.total > 0
			? `${state.percent}% · ${formatBytes(state.loaded)} / ${formatBytes(state.total)}`
			: state.percent > 0
				? `${state.percent}%`
				: t("voice setup preparing");

	return (
		<div className="gui-voice-setup" data-dismissing={dismissing ? "" : undefined} role="dialog" aria-modal="false">
			<div className="gui-voice-setup-head">
				<span className="gui-voice-setup-title">{t("voice setup title")}</span>
				<button type="button" className="gui-voice-setup-close" onClick={close} aria-label={t("later")}>
					✕
				</button>
			</div>
			<div className="gui-voice-setup-body">
				{state.phase === "prompt" && (
					<>
						<p className="gui-voice-setup-desc">
							{t("voice setup desc", { model: state.label, size: state.size })}
						</p>
						<p className="gui-voice-setup-note">{t("voice setup note")}</p>
					</>
				)}
				{state.phase === "downloading" && (
					<>
						<div
							className="gui-voice-setup-bar"
							role="progressbar"
							aria-valuenow={state.percent}
							aria-valuemin={0}
							aria-valuemax={100}
						>
							<div className="gui-voice-setup-bar-fill" style={{ width: `${state.percent}%` }} />
						</div>
						<p className="gui-voice-setup-note">
							{state.label} · {progressText}
						</p>
					</>
				)}
				{state.phase === "error" && <p className="gui-voice-setup-desc">{state.error}</p>}
			</div>
			<div className="gui-voice-setup-actions">
				<button type="button" className="gui-voice-setup-btn" onClick={close}>
					{t("later")}
				</button>
				{state.phase === "prompt" && (
					<button type="button" className="gui-voice-setup-btn gui-voice-setup-btn-primary" onClick={onInstall}>
						{t("voice setup install")}
					</button>
				)}
				{state.phase === "error" && (
					<button type="button" className="gui-voice-setup-btn gui-voice-setup-btn-primary" onClick={onRetry}>
						{t("retry")}
					</button>
				)}
			</div>
		</div>
	);
}
