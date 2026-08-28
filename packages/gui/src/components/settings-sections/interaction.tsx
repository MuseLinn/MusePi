import { t } from "@musepi/desktop-web";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { RpcClient } from "../../lib/rpc";
import { speak, startDictation } from "../../lib/voice";
import { SchemaTabSection } from "./schema";

/**
 * Settings → 交互 → Speech test block: proves the local STT/TTS stack
 * (sherpa-ONNX ASR + Kokoro TTS behind the daemon) is actually usable —
 * the mic button alone gives no feedback about model readiness, which was
 * the user-facing gap. Playback test exercises `tts.synthesize`; the mic
 * test records ~3s and runs `stt.transcribe`, surfacing the transcript or
 * the worker error.
 */
function SpeechTestCard({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [ttsState, setTtsState] = useState<"idle" | "playing" | "ok" | "error">("idle");
	const [sttState, setSttState] = useState<"idle" | "recording" | "ok" | "error">("idle");
	const [sttResult, setSttResult] = useState("");
	const [sttError, setSttError] = useState("");
	const stopRef = useRef<(() => void) | null>(null);

	useEffect(() => {
		return () => stopRef.current?.();
	}, []);

	const runTtsTest = (): void => {
		if (ttsState === "playing") {
			stopRef.current?.();
			setTtsState("idle");
			return;
		}
		setTtsState("playing");
		stopRef.current = speak(t("speech test phrase"), rpc, undefined, activity => {
			if (activity.phase === "done") setTtsState("ok");
			else if (activity.phase === "error") setTtsState("error");
			else if (activity.phase === "stopped") setTtsState("idle");
		});
	};

	const runSttTest = (): void => {
		if (sttState === "recording") {
			stopRef.current?.();
			setSttState("idle");
			return;
		}
		setSttState("recording");
		setSttResult("");
		setSttError("");
		stopRef.current = startDictation(
			text => {
				setSttResult(text);
				setSttState("ok");
			},
			message => {
				setSttError(message);
				setSttState("error");
			},
			rpc,
		);
	};

	return (
		<>
			<div className="gui-settings-row gui-speech-test">
				<div className="min-w-0 flex-1">
					<div className="gui-settings-row-label">{t("speech test")}</div>
					<div className="gui-settings-row-desc">
						{t("speech test hint")} — {t("speech test local note")}
					</div>
				</div>
				<div className="gui-settings-row-extra gui-speech-test-actions">
					<button
						type="button"
						className="gui-btn"
						onClick={runTtsTest}
						disabled={!rpc}
						title={t("speech test tts title")}
					>
						{ttsState === "playing" ? t("stop") : t("speech test tts")}
					</button>
					<button
						type="button"
						className="gui-btn"
						onClick={runSttTest}
						disabled={!rpc}
						title={t("speech test stt title")}
					>
						{sttState === "recording" ? t("stop") : t("speech test stt")}
					</button>
				</div>
			</div>
			{ttsState === "ok" && (
				<div className="gui-settings-row-desc gui-speech-test-ok">{t("speech test tts ok")}</div>
			)}
			{sttState === "ok" && (
				<div className="gui-settings-row-desc gui-speech-test-ok">
					{t("speech test stt ok")}: “{sttResult}”
				</div>
			)}
			{sttState === "error" && <div className="gui-settings-row-desc gui-speech-test-error">{sttError}</div>}
		</>
	);
}

/** Settings → 交互: TUI interaction-tab parity (input/approvals/
 *  notifications/speech/collab/magic-keywords/startup/power/agent/
 *  language/git groups), schema driven. Group-level dedupe — each setting
 *  lives in exactly ONE tab: "Speech" → 语音 tab; "Approvals" → 工具 tab
 *  (approval policy sits next to the tool toggles it gates); "Language" →
 *  外观 tab (its picker dual-writes GUI locale + settings.locale). */
export function InteractionSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	return (
		<>
			<h2 className="gui-settings-page-title">{t("interaction")}</h2>
			<SchemaTabSection rpc={rpc} tabs={["interaction"]} excludeGroups={["Speech", "Approvals", "Language"]} />
			<SpeechTestCard rpc={rpc} />
		</>
	);
}
