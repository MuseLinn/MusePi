import { t, tLoose } from "@musepi/client-core";
import { type ReactNode, useEffect, useState } from "react";
import "../i18n/voice";
import { useFloatingMenu } from "../lib/use-floating-menu";
import { enumerateMicDevices, getVoiceInputDevice, type MicDevice, setVoiceInputDevice } from "../lib/voice";
import { Icon } from "../vendor/oc-icons";

type MonitorError = "denied" | "unavailable" | null;

function microphoneError(cause: unknown): Exclude<MonitorError, null> {
	const name = typeof cause === "object" && cause !== null && "name" in cause ? String(cause.name) : "";
	return name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError"
		? "denied"
		: "unavailable";
}

/** Open the selected microphone only while the owning surface is active. */
function useMicrophoneLevel(active: boolean, deviceId: string | null): { level: number; error: MonitorError } {
	const [level, setLevel] = useState(0);
	const [error, setError] = useState<MonitorError>(null);

	useEffect(() => {
		setLevel(0);
		setError(null);
		if (!active) return;

		let cancelled = false;
		let stream: MediaStream | null = null;
		let context: AudioContext | null = null;
		let source: MediaStreamAudioSourceNode | null = null;
		let analyser: AnalyserNode | null = null;
		let frame: number | null = null;

		const start = async (): Promise<void> => {
			if (!navigator.mediaDevices?.getUserMedia) {
				setError("unavailable");
				return;
			}
			try {
				stream = await navigator.mediaDevices.getUserMedia({
					audio: deviceId ? { deviceId: { exact: deviceId } } : true,
				});
				// Closing a persistent dialog does not unmount it. A stream that
				// arrives after close must be stopped here, not attached to a graph.
				if (cancelled) {
					stream.getTracks().forEach(track => track.stop());
					return;
				}
				context = new AudioContext();
				source = context.createMediaStreamSource(stream);
				analyser = context.createAnalyser();
				analyser.fftSize = 512;
				analyser.smoothingTimeConstant = 0.75;
				source.connect(analyser);
				const samples = new Uint8Array(analyser.fftSize);
				const update = (): void => {
					if (cancelled || !analyser) return;
					analyser.getByteTimeDomainData(samples);
					let sum = 0;
					for (const sample of samples) {
						const value = (sample - 128) / 128;
						sum += value * value;
					}
					setLevel(Math.min(1, Math.sqrt(sum / samples.length) * 4));
					frame = requestAnimationFrame(update);
				};
				void context.resume().catch(() => {});
				update();
			} catch (cause) {
				stream?.getTracks().forEach(track => track.stop());
				source?.disconnect();
				analyser?.disconnect();
				if (context) void context.close().catch(() => {});
				if (!cancelled) setError(microphoneError(cause));
			}
		};
		void start();

		return () => {
			cancelled = true;
			if (frame !== null) cancelAnimationFrame(frame);
			source?.disconnect();
			analyser?.disconnect();
			stream?.getTracks().forEach(track => track.stop());
			if (context) void context.close().catch(() => {});
		};
	}, [active, deviceId]);

	return { level, error };
}

function InputDeviceMenu({
	devices,
	deviceId,
	onChange,
}: {
	devices: MicDevice[];
	deviceId: string | null;
	onChange(deviceId: string | null): void;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const { anchorRef, renderMenu } = useFloatingMenu(open, setOpen);
	const current = devices.find(device => device.deviceId === deviceId);
	return (
		<div className="gui-voice-device" ref={anchorRef}>
			<button
				type="button"
				className="gui-btn"
				disabled={devices.length === 0}
				aria-label={t("settings.voiceInputDevice")}
				aria-expanded={open}
				aria-haspopup="menu"
				onClick={() => setOpen(value => !value)}
			>
				<Icon name="mic" className="h-3.5 w-3.5" />
				<span className="gui-voice-device-label">{current?.label ?? t("settings.systemDefault")}</span>
				<Icon name="arrow-down-s" className="h-3.5 w-3.5" />
			</button>
			{renderMenu(
				<div className="gui-attach-menu" role="menu" aria-label={t("settings.voiceInputDevice")}>
					<button
						type="button"
						className="gui-attach-opt"
						role="menuitemradio"
						aria-checked={deviceId === null}
						onClick={() => {
							onChange(null);
							setOpen(false);
						}}
					>
						<span className="min-w-0 flex-1">
							<span className="gui-attach-opt-title">{t("settings.systemDefault")}</span>
						</span>
						{deviceId === null && <Icon name="check" className="h-4 w-4" />}
					</button>
					{devices.map(device => (
						<button
							key={device.deviceId}
							type="button"
							className="gui-attach-opt"
							role="menuitemradio"
							aria-checked={deviceId === device.deviceId}
							onClick={() => {
								onChange(device.deviceId);
								setOpen(false);
							}}
						>
							<span className="min-w-0 flex-1">
								<span className="gui-attach-opt-title">{device.label}</span>
							</span>
							{deviceId === device.deviceId && <Icon name="check" className="h-4 w-4" />}
						</button>
					))}
				</div>,
			)}
		</div>
	);
}

/** Shared settings/detail control: machine-local selection, device refresh,
 * permission feedback, and a live meter with no separate detection button. */
export function VoiceInputDevicePicker({ active }: { active: boolean }): ReactNode {
	const [devices, setDevices] = useState<MicDevice[]>([]);
	const [deviceId, setDeviceId] = useState<string | null>(() => getVoiceInputDevice());
	const { level, error } = useMicrophoneLevel(active, deviceId);

	useEffect(() => {
		if (!active) return;
		let cancelled = false;
		const refresh = async (): Promise<void> => {
			const next = await enumerateMicDevices();
			if (cancelled) return;
			setDevices(next);
			setDeviceId(current => {
				if (!current || next.some(device => device.deviceId === current)) return current;
				setVoiceInputDevice(null);
				return null;
			});
		};
		void refresh();
		const media = navigator.mediaDevices;
		media?.addEventListener?.("devicechange", refresh);
		return () => {
			cancelled = true;
			media?.removeEventListener?.("devicechange", refresh);
		};
	}, [active]);

	const selectDevice = (next: string | null): void => {
		setDeviceId(next);
		setVoiceInputDevice(next);
	};

	return (
		<div className="gui-voice-device-control">
			<InputDeviceMenu devices={devices} deviceId={deviceId} onChange={selectDevice} />
			<div
				className="gui-voice-input-meter"
				role="meter"
				aria-label={tLoose("Microphone level")}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={Math.round(level * 100)}
			>
				<span style={{ width: `${Math.round(level * 100)}%` }} />
			</div>
			{error && (
				<div className="gui-voice-input-error" role="status">
					{error === "denied" ? tLoose("Microphone permission denied") : tLoose("No microphone available")}
				</div>
			)}
		</div>
	);
}
