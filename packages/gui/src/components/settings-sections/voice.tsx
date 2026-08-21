/*
 * Settings → 语音: dedicated voice I/O section (STT input + TTS output),
 * split out of the old hand-written block in notifications.tsx (removed).
 * Registered as section=voice in SettingsView; uses local state + direct
 * settings.set writes for the daemon-persisted keys.
 */
import { t } from "@musepi/desktop-web";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { RpcClient } from "../../lib/rpc";
import { Icon } from "../../vendor/oc-icons";
import { GuiSelect } from "../GuiSelect";
import {
	STT_SUBMIT_TRIGGERS,
	enumerateMicDevices,
	speak,
	startDictationOpts,
	type SttSubmitTrigger,
	type VoiceActivity,
} from "../../lib/voice";

/* ── 本地态（非 schema）────────────────────────────────────────── */
interface MicDevice { deviceId: string; label: string }
const KOKORO_VOICES = [
	{ value: "af_heart", label: "af_heart · 美式甜心（默认）" },
	{ value: "am_michael", label: "am_michael · 美式男声" },
	{ value: "bf_emma", label: "bf_emma · 英式女声" },
	{ value: "af_sarah", label: "af_sarah · 沉稳女声" },
] as const;

/* 一次 set 调用（沿用 notifications.tsx 的 `settings.set` 惯例） */
function useSetting(rpc: RpcClient | null) {
	return (key: string, value: unknown) => void rpc?.request("settings.set", { key, value }).catch(() => {});
}

/** 语音输出播放态卡（loading → speaking → done / stopped / error）。 */
function TtsTestCard({ rpc, voice, rate, mode }: { rpc: RpcClient | null; voice: string; rate: number; mode: "raw" | "sanitize" | "summarize" }): ReactNode {
	const [state, setState] = useState<"idle" | "loading" | "speaking" | "ok" | "error">("idle");
	const [err, setErr] = useState("");
	const stopRef = useRef<(() => void) | null>(null);
	useEffect(() => () => stopRef.current?.(), []);
	const toggle = (): void => {
		if (state === "speaking" || state === "loading") { stopRef.current?.(); setState("idle"); return; }
		setState("loading"); setErr("");
		stopRef.current = speak(t("voice output sample"), rpc, { voice, rate, mode }, (a: VoiceActivity) => {
			if (a.phase === "speaking") setState("speaking");
			else if (a.phase === "done") setState("ok");
			else if (a.phase === "stopped") setState("idle");
			else if (a.phase === "error") { setState("error"); setErr(a.message); }
		});
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
	const set = useSetting(rpc);

	// schema 键（可走 SchemaTabSection；此处为保持单页聚合，直接读写）
	const [sttEnabled, setSttEnabled] = useState(true);
	const [sttModel, setSttModel] = useState("parakeet");
	const [sttLanguage, setSttLanguage] = useState("auto");
	const [sttVad, setSttVad] = useState(true);
	const [sttVadMs, setSttVadMs] = useState(700);
	const [sttSens, setSttSens] = useState(5);
	const [sttSubmit, setSttSubmit] = useState<SttSubmitTrigger>("never");

	const [autoRead, setAutoRead] = useState(false);   // tts.autoRead（修正：不再写 speech.enabled）
	const [ttsProvider, setTtsProvider] = useState("kokoro");
	const [ttsVoice, setTtsVoice] = useState("af_heart");
	const [ttsRate, setTtsRate] = useState(1);
	const [ttsMode, setTtsMode] = useState<"raw" | "sanitize" | "summarize">("sanitize");
	const [ttsBarge, setTtsBarge] = useState<"duck" | "pause">("duck");

	// 麦克风设备枚举
	const [devices, setDevices] = useState<MicDevice[]>([]);
	const [micDevice, setMicDevice] = useState("default");
	const [dictate, setDictate] = useState(false);
	const [dictateText, setDictateText] = useState<string | null>(null);
	const dictRef = useRef<(() => void) | null>(null);

	useEffect(() => { enumerateMicDevices().then(setDevices).catch(() => setDevices([])); }, []);
	useEffect(() => () => dictRef.current?.(), []);
	// Seed the dictation-submit select from the daemon schema key the
	// composer actually reads (stt.submitTrigger, TUI parity).
	useEffect(() => {
		if (!rpc) return;
		void rpc
			.request<Record<string, unknown> | null>("settings.get", { keys: ["stt.submitTrigger"] })
			.then(v => {
				const t = v?.["stt.submitTrigger"];
				if (typeof t === "string" && (STT_SUBMIT_TRIGGERS as readonly string[]).includes(t)) {
					setSttSubmit(t as SttSubmitTrigger);
				}
			})
			.catch(() => {});
	}, [rpc]);

	/* 把枚举的设备标签转成 GuiSelect options */
	const micOptions = useMemo(
		() => [
			{ value: "default", label: "默认麦克风" },
			...devices.map(d => ({ value: d.deviceId, label: d.label })),
		],
		[devices],
	);

	const onDictate = (): void => {
		if (dictate) { dictRef.current?.(); setDictate(false); return; }
		setDictateText(null); setDictate(true);
		dictRef.current = startDictationOpts({
			rpc,
			language: sttLanguage === "auto" ? undefined : sttLanguage,
			deviceId: micDevice === "default" ? undefined : micDevice,
			vadEndMs: sttVad ? sttVadMs : undefined,
			bargeIn: ttsBarge,
			onFinal: text => { setDictateText(text); setDictate(false); },
			onError: () => setDictate(false),
		});
	};

	return (
		<>
			<h2 className="gui-settings-page-title">{t("voice")}</h2>

			{/* 语音输入 */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("voice input")} · STT</div>

				<div className="gui-settings-row">
					<div><div className="gui-settings-row-label">{t("voice input")}</div><div className="gui-settings-row-desc">{t("voice input description")}</div></div>
					<button type="button" role="switch" aria-checked={sttEnabled}
						className={`gui-toggle${sttEnabled ? " gui-toggle--on" : ""}`}
						onClick={() => { const v = !sttEnabled; setSttEnabled(v); set("stt.enabled", v); }}
						aria-label={t("voice input")}>
						<span className="gui-toggle-knob" />
					</button>
				</div>

				<div className="gui-settings-row">
					<div><div className="gui-settings-row-label">{t("voice input model")}</div><div className="gui-settings-row-desc">Parakeet(TiDiT) 本地 · 25 语种 · 低延迟</div></div>
					<GuiSelect className="gui-input max-w-[220px]" value={sttModel} onChange={v => { setSttModel(v); set("stt.modelName", v); }}
						options={[
							{ value: "parakeet", label: "Parakeet TDT 0.6B (推荐)" },
							{ value: "turbo", label: "Whisper Large-v3-turbo (99 语种)" },
							{ value: "balanced", label: "Whisper Small · 均衡" },
							{ value: "fast", label: "Whisper Base · 快速" },
						]} />
				</div>

				<div className="gui-settings-row">
					<div><div className="gui-settings-row-label">{t("voice input language")}</div><div className="gui-settings-row-desc">透传给 stt.transcribe(language)</div></div>
					<GuiSelect className="gui-input max-w-[220px]" value={sttLanguage} onChange={v => { setSttLanguage(v); set("stt.language", v); }}
						options={[
							{ value: "auto", label: "自动检测" },
							{ value: "zh-CN", label: "普通话 (zh-CN)" },
							{ value: "en-US", label: "English (en-US)" },
							{ value: "zh-Yue", label: "粤语 (zh-Yue)" },
							{ value: "ja", label: "日本語 (ja)" },
						]} />
				</div>

				<div className="gui-settings-row">
					<div><div className="gui-settings-row-label">{t("voice input device")}</div><div className="gui-settings-row-desc">默认 · 外接 USB / 蓝牙可切换</div></div>
					<GuiSelect className="gui-input max-w-[220px]" value={micDevice} onChange={setMicDevice} options={micOptions} />
				</div>

				<div className="gui-settings-row">
					<div><div className="gui-settings-row-label">{t("voice input vad")}</div><div className="gui-settings-row-desc">静音后自动结束口述，替代固定 15 秒上限</div></div>
					<button type="button" role="switch" aria-checked={sttVad}
						className={`gui-toggle${sttVad ? " gui-toggle--on" : ""}`}
						onClick={() => { const v = !sttVad; setSttVad(v); set("stt.vadEndMs", v ? sttVadMs : null); }}
						aria-label={t("voice input vad")}>
						<span className="gui-toggle-knob" />
					</button>
				</div>

				<div className="gui-settings-row">
					<div><div className="gui-settings-row-label">{t("voice input vad ms")}</div><div className="gui-settings-row-desc">说什么级别的停顿算“说完”</div></div>
					<input type="range" min={300} max={1500} step={100} value={sttVadMs}
						aria-label={`${t("voice input vad ms")}（毫秒）`}
						onChange={e => { const v = Number(e.target.value); setSttVadMs(v); set("stt.vadEndMs", v); }} />
				</div>

				<div className="gui-settings-row">
					<div><div className="gui-settings-row-label">{t("voice input submit")}</div><div className="gui-settings-row-desc">口述结束后：插入草稿，或按条件自动发送（与终端 stt.submitTrigger 同步）</div></div>
					<GuiSelect
						className="gui-input max-w-[180px]"
						value={sttSubmit}
						onChange={v => { setSttSubmit(v as SttSubmitTrigger); set("stt.submitTrigger", v); }}
						options={[
							{ value: "never", label: "仅插入草稿" },
							{ value: "release", label: "说完即发（≥2 词）" },
							{ value: "release-complete", label: "完整句末标点才发" },
							{ value: "say-submit", label: "说 \"submit\" 才发" },
						]} />
				</div>

				<div className="gui-settings-row">
					<div><div className="gui-settings-row-label">{t("voice input test")}</div>
						<div className="gui-settings-row-desc" aria-live="polite">{dictateText ?? t("voice input test description")}</div></div>
					<button type="button" className="gui-btn" disabled={!rpc} onClick={onDictate}>
						<Icon name="mic" className="h-3.5 w-3.5" />{dictate ? t("recording…") : t("voice input test")}
					</button>
				</div>
			</div>

			{/* 语音输出 */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("voice output")} · TTS</div>

				<div className="gui-settings-row">
					<div><div className="gui-settings-row-label">{t("voice output auto read")}</div><div className="gui-settings-row-desc">对应 tts.autoRead · 修复原先误用 speech.enabled 的问题</div></div>
					<button type="button" role="switch" aria-checked={autoRead}
						className={`gui-toggle${autoRead ? " gui-toggle--on" : ""}`}
						onClick={() => { const v = !autoRead; setAutoRead(v); set("tts.autoRead", v); }}
						aria-label={t("voice output auto read")}>
						<span className="gui-toggle-knob" />
					</button>
				</div>

				<div className="gui-settings-row">
					<div><div className="gui-settings-row-label">{t("voice output provider")}</div><div className="gui-settings-row-desc">默认本机 Kokoro，无网络依赖</div></div>
					<GuiSelect className="gui-input max-w-[220px]" value={ttsProvider} onChange={v => { setTtsProvider(v); set("tts.localModel", v); }}
						options={[
							{ value: "kokoro", label: "本机 · Kokoro-82M（推荐）" },
							{ value: "browser", label: "浏览器 speechSynthesis" },
							{ value: "openai", label: "OpenAI 兼容服务" },
						]} />
				</div>

				<div className="gui-settings-row">
					<div><div className="gui-settings-row-label">{t("voice output voice")}</div><div className="gui-settings-row-desc">Kokoro 12 声 · 选后试听</div></div>
					<div className="gui-settings-row-extra" style={{ display: "flex", gap: 8, alignItems: "center" }}>
						<GuiSelect className="gui-input max-w-[220px]" value={ttsVoice} onChange={v => { setTtsVoice(v); set("tts.localVoice", v); }} options={KOKORO_VOICES as never} />
					</div>
				</div>

				<div className="gui-settings-row">
					<div><div className="gui-settings-row-label">{t("voice output rate")}</div><div className="gui-settings-row-desc">0.5× – 2.0×，读书/演示场景常用 0.8×（当前引擎暂不支持调速，仅保存偏好）</div></div>
					<input type="range" min={0.5} max={2} step={0.1} value={ttsRate} aria-label={`${t("voice output rate")}（0.5×–2.0×）`}
						onChange={e => { const v = Number(e.target.value); setTtsRate(v); set("tts.rate", v); }} />
				</div>

				<div className="gui-settings-row">
					<div><div className="gui-settings-row-label">{t("voice output mode")}</div><div className="gui-settings-row-desc">长回复建议“摘要+净化”</div></div>
					<GuiSelect className="gui-input max-w-[180px]" value={ttsMode} onChange={v => { setTtsMode(v as typeof ttsMode); set("tts.inputMode", v); }}
						options={[
							{ value: "sanitize", label: "净化" },
							{ value: "summarize", label: "摘要+净化" },
							{ value: "raw", label: "原文" },
						]} />
				</div>

				<div className="gui-settings-row">
					<div><div className="gui-settings-row-label">{t("voice output barge in")}</div><div className="gui-settings-row-desc">朗读时开始口述，自动播放音量降到 25% 或暂停</div></div>
					<GuiSelect className="gui-input max-w-[180px]" value={ttsBarge} onChange={v => { setTtsBarge(v as typeof ttsBarge); set("tts.bargeIn", v); }}
						options={[
							{ value: "duck", label: "暂时压低" },
							{ value: "pause", label: "暂停" },
						]} />
				</div>

				<TtsTestCard rpc={rpc} voice={ttsVoice} rate={ttsRate} mode={ttsMode} />
			</div>
		</>
	);
}
