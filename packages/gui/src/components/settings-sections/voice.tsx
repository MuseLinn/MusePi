/*
 * Settings → 语音: dedicated voice I/O section. The stt.* / tts.* schema keys
 * render through <SchemaTabSection tabs={["interaction"]}> (the daemon
 * schema is the single source of truth — the same rows used to be
 * hand-duplicated here with hardcoded defaults that never loaded real
 * values, and drifted from the 交互 tab's schema-driven copies). This file
 * keeps only what the schema cannot express: live mic enumeration, the
 * dictation test, and the TTS test card.
 */
import { t } from "@musepi/desktop-web";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { RpcClient } from "../../lib/rpc";
import { Icon } from "../../vendor/oc-icons";
import { SchemaTabSection } from "./schema";
import { enumerateMicDevices, speak, startDictation, type VoiceActivity } from "../../lib/voice";

/** TTS test card: synthesizes the sample phrase with the CURRENT schema
 * values (read live from settings.get, so the test always matches what
 * chat playback will use). */
function TtsTestCard({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [state, setState] = useState<"idle" | "loading" | "speaking" | "ok" | "error">("idle");
	const [err, setErr] = useState("");
	const stopRef = useRef<(() => void) | null>(null);
	useEffect(() => () => stopRef.current?.(), []);
	const toggle = (): void => {
		if (state === "speaking" || state === "loading") { stopRef.current?.(); setState("idle"); return; }
		setState("loading"); setErr("");
		void rpc
			?.request<Record<string, unknown>>("settings.get", { keys: ["tts.localVoice", "tts.rate", "tts.inputMode"] })
			.then(v =>
				new Promise<void>(resolve => {
					stopRef.current = speak(t("voice output sample"), rpc, {
						voice: typeof v["tts.localVoice"] === "string" ? (v["tts.localVoice"] as string) : undefined,
						rate: typeof v["tts.rate"] === "number" ? (v["tts.rate"] as number) : undefined,
						mode: typeof v["tts.inputMode"] === "string" ? (v["tts.inputMode"] as "raw" | "sanitize" | "summarize") : undefined,
					}, (a: VoiceActivity) => {
						if (a.phase === "speaking") setState("speaking");
						else if (a.phase === "done") setState("ok");
						else if (a.phase === "stopped") setState("idle");
						else if (a.phase === "error") { setState("error"); setErr(a.message); }
						if (a.phase === "done" || a.phase === "stopped" || a.phase === "error") resolve();
					});
				}),
			)
			.catch(() => {})
			.finally(() => { /* state driven by activity callback */ });
	};
	return (
		<div className="gui-settings-row">
			<div>
				<div className="gui-settings-row-label">{t("voice output test")}</div>
				<div className="gui-settings-row-desc" aria-live="polite">
					{state === "ok" ? t("voice output played") : state === "error" ? err : t("voice output test description")}
				</div>
			</div>
			<button type="button" className="gui-btn" disabled={!rpc} onClick={toggle}>
				<Icon name={state === "loading" ? "download" : state === "speaking" ? "stop" : "play"} className="h-3.5 w-3.5" />
				{state === "speaking" || state === "loading" ? t("stop") : t("voice output test")}
			</button>
		</div>
	);
}

/** Settings → 语音。 */
export function VoiceSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	// Schema keys render via SchemaTabSection below. Local state covers
	// only the live mic test (device enumeration + dictation round-trip).
	const [devices, setDevices] = useState<{ deviceId: string; label: string }[]>([]);
	const [dictating, setDictating] = useState(false);
	const [dictated, setDictated] = useState<string | null>(null);
	const stopRef = useRef<(() => void) | null>(null);

	useEffect(() => {
		void enumerateMicDevices().then(setDevices).catch(() => setDevices([]));
		return () => stopRef.current?.();
	}, []);

	const toggleDictation = (): void => {
		if (dictating) { stopRef.current?.(); setDictating(false); return; }
		setDictated(null); setDictating(true);
		stopRef.current = startDictation(
			(text: string) => { setDictated(text); setDictating(false); },
			() => setDictating(false),
			rpc,
		);
	};

	return (
		<>
			<h2 className="gui-settings-page-title">{t("voice")}</h2>

			{/* Schema-driven stt.* / tts.* rows — only the interaction tab's
			 * "Speech" group, NOT the whole tab (the rest of the interaction
			 * groups live on 交互; duplicating them here was the old bug). */}
			<SchemaTabSection rpc={rpc} tabs={["interaction"]} groups={["Speech"]} />

			{/* Live device + dictation test: not expressible in schema. */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("voice input test")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("voice input device")}</div>
						<div className="gui-settings-row-desc">
							{devices.length > 0 ? devices.map(d => d.label).join(" · ") : t("voice input test description")}
						</div>
					</div>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("voice input test")}</div>
						<div className="gui-settings-row-desc" aria-live="polite">{dictated ?? t("voice input test description")}</div>
					</div>
					<button type="button" className="gui-btn" disabled={!rpc} onClick={toggleDictation}>
						<Icon name="mic" className="h-3.5 w-3.5" />{dictating ? t("recording…") : t("voice input test")}
					</button>
				</div>
			</div>

			<TtsTestCard rpc={rpc} />
		</>
	);
}
