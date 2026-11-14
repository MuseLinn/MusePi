import { getLocaleSnapshot, t, tLoose, useLocale } from "@musepi/client-core";
import { isSttDownloadEvent, type SttModelStatusResponse } from "@musepi/pi-wire";
import { Download as DownloadIconData, Mic as MicIconData, TriangleAlert as TriangleAlertIconData } from "lucide";
import { MorphIcon } from "morphicons/react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import "../i18n/voice";
import { onboardingPending } from "../lib/onboarding";
import type { RpcClient } from "../lib/rpc";
import { probeMicrophone } from "../lib/voice";
import { GuiSelect } from "./GuiSelect";

type MicrophonePhase = "unknown" | "granted" | "checking" | "ready" | "denied" | "unavailable";
type ModelPhase = "loading" | "missing" | "ready" | "downloading" | "error" | "unavailable";
type ModelRow = SttModelStatusResponse["models"][number];

interface ModelState {
	key: string;
	label: string;
	phase: ModelPhase;
	percent: number;
}

const INITIAL_MODEL: ModelState = { key: "", label: "", phase: "loading", percent: 0 };

function recommendedSttModelKey(locale = getLocaleSnapshot()): "balanced" | "sensevoice" {
	return locale.toLowerCase().startsWith("zh") ? "sensevoice" : "balanced";
}

/** Voice onboarding performs real device and model checks. Leaving the step
 * never cancels a daemon download; returning reconciles with modelStatus. */
export function OnboardingVoiceSetup({
	rpc,
	selectedKey,
	onSelectedKey,
}: {
	rpc: RpcClient | null;
	selectedKey: string;
	onSelectedKey(key: string): void;
}): ReactNode {
	const locale = useLocale();
	const recommendedKey = recommendedSttModelKey(locale);
	const [microphone, setMicrophone] = useState<MicrophonePhase>("unknown");
	const [model, setModel] = useState<ModelState>(INITIAL_MODEL);
	const [models, setModels] = useState<ModelRow[]>([]);
	const modelKey = useRef("");
	const microphoneGeneration = useRef(0);
	const modelGeneration = useRef(0);

	useEffect(() => {
		let active = true;
		let permission: PermissionStatus | null = null;
		const update = (): void => {
			if (!active || !permission) return;
			setMicrophone(
				permission.state === "granted" ? "granted" : permission.state === "denied" ? "denied" : "unknown",
			);
		};
		try {
			void navigator.permissions
				?.query({ name: "microphone" })
				.then(result => {
					if (!active) return;
					permission = result;
					permission.addEventListener("change", update);
					update();
				})
				.catch(() => {});
		} catch {
			// Permission queries are not available in every embedded browser. The
			// explicit device check below remains authoritative.
		}
		return () => {
			active = false;
			microphoneGeneration.current += 1;
			permission?.removeEventListener("change", update);
		};
	}, []);

	const refreshModel = useCallback(async (): Promise<void> => {
		if (!rpc) {
			setModel({ ...INITIAL_MODEL, phase: "unavailable" });
			return;
		}
		const generation = ++modelGeneration.current;
		setModel(previous => ({ ...previous, phase: "loading" }));
		try {
			const status = await rpc.request<SttModelStatusResponse>("stt.modelStatus", {});
			if (generation !== modelGeneration.current) return;
			setModels(status.models);
			const recommended = onboardingPending() ? recommendedKey : "";
			const key = [selectedKey, recommended, status.defaultKey ?? "", status.models[0]?.key ?? ""].find(candidate =>
				status.models.some(item => item.key === candidate),
			);
			const row = status.models.find(item => item.key === key);
			if (!key || !row) {
				setModel({ key: "", label: "", phase: "unavailable", percent: 0 });
				return;
			}
			if (!selectedKey && key !== status.defaultKey) {
				await rpc.request("settings.set", { key: "stt.modelName", value: key });
				if (generation !== modelGeneration.current) return;
			}
			modelKey.current = key;
			onSelectedKey(key);
			setModel({
				key,
				label: row.label,
				phase: row.cached ? "ready" : status.downloads?.includes(key) ? "downloading" : "missing",
				percent: 0,
			});
		} catch {
			if (generation === modelGeneration.current) setModel({ ...INITIAL_MODEL, phase: "unavailable" });
		}
	}, [onSelectedKey, recommendedKey, rpc, selectedKey]);

	useEffect(() => {
		void refreshModel();
	}, [refreshModel]);

	useEffect(() => {
		if (!rpc) return;
		const off = rpc.addEventListener(event => {
			const payload = event.payload;
			if (!isSttDownloadEvent(payload) || payload.modelKey !== modelKey.current) return;
			if (payload.type === "stt.downloadProgress") {
				setModel(previous => ({ ...previous, phase: "downloading", percent: payload.percent }));
				return;
			}
			if (payload.type === "stt.downloadDone") {
				void refreshModel();
				return;
			}
			setModel(previous => ({ ...previous, phase: "error" }));
		});
		return off;
	}, [rpc, refreshModel]);

	const checkMicrophone = async (): Promise<void> => {
		const generation = ++microphoneGeneration.current;
		setMicrophone("checking");
		const result = await probeMicrophone();
		if (generation === microphoneGeneration.current) setMicrophone(result);
	};

	const selectModel = async (key: string): Promise<void> => {
		const row = models.find(item => item.key === key);
		if (!rpc || !row || model.phase === "downloading") return;
		modelKey.current = key;
		onSelectedKey(key);
		setModel({ key, label: row.label, phase: row.cached ? "ready" : "missing", percent: 0 });
		try {
			await rpc.request("settings.set", { key: "stt.modelName", value: key });
		} catch {
			setModel(previous => ({ ...previous, phase: "unavailable" }));
		}
	};

	const download = (): void => {
		if (!rpc || !model.key) return;
		setModel(previous => ({ ...previous, phase: "downloading", percent: 0 }));
		void rpc.request("stt.modelDownload", { modelKey: model.key }).catch(() => {
			setModel(previous => ({ ...previous, phase: "error" }));
		});
	};

	const microphoneCopy = {
		unknown: tLoose("Microphone permission not checked"),
		granted: tLoose("Microphone permission granted"),
		checking: tLoose("Checking microphone…"),
		ready: tLoose("Microphone ready"),
		denied: tLoose("Microphone permission denied"),
		unavailable: tLoose("No microphone available"),
	}[microphone];

	return (
		<div className="gui-obo-voice-setup">
			<section className="gui-obo-voice-check" data-state={microphone}>
				<span className="gui-obo-voice-check-icon" aria-hidden="true">
					<MorphIcon
						icon={microphone === "denied" || microphone === "unavailable" ? TriangleAlertIconData : MicIconData}
						size={16}
						spring="snappy"
						reducedMotion="user"
					/>
				</span>
				<div className="gui-obo-voice-check-copy">
					<div className="gui-obo-voice-check-title">{tLoose("Microphone")}</div>
					<p role="status">{microphoneCopy}</p>
				</div>
				<button
					type="button"
					className="gui-btn"
					disabled={microphone === "checking"}
					onClick={() => void checkMicrophone()}
				>
					{microphone === "checking"
						? tLoose("Checking microphone…")
						: microphone === "ready" || microphone === "denied" || microphone === "unavailable"
							? tLoose("Recheck")
							: tLoose("Check microphone")}
				</button>
			</section>

			<section className="gui-obo-voice-check" data-state={model.phase}>
				<span className="gui-obo-voice-check-icon" aria-hidden="true">
					<MorphIcon
						icon={
							model.phase === "error" || model.phase === "unavailable" ? TriangleAlertIconData : DownloadIconData
						}
						size={16}
						spring="snappy"
						reducedMotion="user"
					/>
				</span>
				<div className="gui-obo-voice-check-copy">
					<div className="gui-obo-voice-check-title">{tLoose("Recognition model")}</div>
					{models.length > 0 && model.phase !== "loading" && model.phase !== "unavailable" && (
						<>
							<GuiSelect
								className="gui-obo-voice-model-select"
								ariaLabel={tLoose("Recognition model")}
								value={model.key}
								disabled={model.phase === "downloading"}
								onChange={key => void selectModel(key)}
								options={models.map(row => ({
									value: row.key,
									label: `${row.label}${row.key === recommendedKey ? ` · ${tLoose("Recommended")}` : ""}`,
								}))}
							/>
							{model.key === recommendedKey && (
								<p className="gui-obo-voice-recommendation">
									{tLoose(
										recommendedKey === "sensevoice"
											? "Recommended for Chinese interface"
											: "Recommended for multilingual input",
									)}
								</p>
							)}
						</>
					)}
					<p role="status">
						{model.phase === "loading" && tLoose("Checking recognition model…")}
						{model.phase === "missing" && tLoose("Recognition model required", { model: model.label })}
						{model.phase === "ready" && tLoose("Speech model ready", { model: model.label })}
						{model.phase === "downloading" && tLoose("Downloading recognition model", { model: model.label })}
						{model.phase === "error" && tLoose("Recognition model download failed")}
						{model.phase === "unavailable" && tLoose("Recognition model status unavailable")}
					</p>
					{model.phase === "downloading" && (
						<progress
							max={100}
							value={model.percent}
							aria-label={tLoose("Downloading recognition model", { model: model.label })}
						/>
					)}
				</div>
				{(model.phase === "missing" || model.phase === "error") && (
					<button type="button" className="gui-btn" disabled={!rpc} onClick={download}>
						{model.phase === "error" ? t("settings.retry") : tLoose("Download recognition model")}
					</button>
				)}
				{model.phase === "unavailable" && (
					<button type="button" className="gui-btn" disabled={!rpc} onClick={() => void refreshModel()}>
						{tLoose("Recheck")}
					</button>
				)}
			</section>
			<p className="gui-obo-voice-note">{tLoose("Voice setup can be finished later")}</p>
		</div>
	);
}
