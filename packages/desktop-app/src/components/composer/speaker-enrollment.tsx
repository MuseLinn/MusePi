import { tLoose } from "@musepi/client-core";
import { Check, CircleAlert, LoaderCircle, Mic } from "lucide";
import { MorphIcon } from "morphicons/react";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import "../../i18n/voice";
import type { RpcClient } from "../../lib/rpc";
import { quantiseForWire, recordPcm } from "../../lib/voice";
import { DialogFrame } from "../DialogFrame";
import { HeightMorph } from "../HeightMorph";
import { Reveal } from "../Reveal";

const PROMPTS = [
	"Clear ideas sound better when I say them aloud.",
	"The quiet morning light moves across my desk.",
	"Every small improvement makes the tool more useful.",
	"I can speak naturally without rushing my words.",
	"This last sentence confirms that my voice is ready.",
];

type EnrollmentPhase = "idle" | "preparing" | "recording" | "processing" | "accepted" | "error" | "complete";

export interface EnrollmentCapture {
	done: Promise<{ pcm: Float32Array } | null>;
	stop(): void;
}

export function SpeakerEnrollment({
	open,
	onClose,
	rpc,
	capture = onLevel => recordPcm({ maxSeconds: 6, vadEndMs: 900, onLevel }),
	onChanged,
	hasProfile = false,
}: {
	open: boolean;
	onClose(): void;
	rpc: RpcClient | null;
	capture?: (onLevel: (level: number) => void) => EnrollmentCapture;
	onChanged?(): void;
	hasProfile?: boolean;
}): ReactNode {
	const [count, setCount] = useState(0);
	const [level, setLevel] = useState(0);
	const [phase, setPhase] = useState<EnrollmentPhase>("idle");
	const [error, setError] = useState("");
	const recorder = useRef<EnrollmentCapture | null>(null);
	const acceptanceTimer = useRef<number | null>(null);
	const generation = useRef(0);
	const wasOpen = useRef(open);

	const clearAcceptance = (): void => {
		if (acceptanceTimer.current !== null) window.clearTimeout(acceptanceTimer.current);
		acceptanceTimer.current = null;
	};

	const cancel = (): void => {
		generation.current += 1;
		clearAcceptance();
		recorder.current?.stop();
		recorder.current = null;
		setPhase("idle");
		void rpc?.request("voice.speakerEnrollmentCancel", {}).catch(() => {});
		onClose();
	};

	useEffect(() => {
		if (open && !wasOpen.current && phase === "complete") {
			setCount(0);
			setPhase("idle");
		}
		wasOpen.current = open;
	}, [open, phase]);

	useEffect(
		() => () => {
			generation.current += 1;
			clearAcceptance();
			recorder.current?.stop();
		},
		[],
	);

	const record = async (): Promise<void> => {
		if (!rpc || phase === "preparing" || phase === "processing") return;
		if (phase === "recording") {
			recorder.current?.stop();
			return;
		}
		clearAcceptance();
		const current = generation.current;
		setError("");
		setLevel(0);
		setPhase("preparing");
		try {
			if (count === 0) await rpc.request("voice.speakerEnrollmentStart", {});
			if (current !== generation.current) return;
			setPhase("recording");
			const active = capture(setLevel);
			recorder.current = active;
			const recorded = await active.done;
			recorder.current = null;
			if (current !== generation.current) return;
			if (!recorded) throw new Error(tLoose("Microphone unavailable"));
			setPhase("processing");
			const audio = quantiseForWire(recorded.pcm);
			if (count < 4) {
				const result = await rpc.request<{ accepted: boolean; reason?: string }>("voice.speakerEnrollmentAdd", {
					audio,
					sampleRate: 16_000,
				});
				if (current !== generation.current) return;
				if (!result.accepted) {
					setError(result.reason ?? tLoose("Try that phrase again"));
					setPhase("error");
					return;
				}
				setCount(value => value + 1);
				setPhase("accepted");
				acceptanceTimer.current = window.setTimeout(() => {
					acceptanceTimer.current = null;
					if (current === generation.current) setPhase("idle");
				}, 360);
			} else {
				const result = await rpc.request<{ ok: boolean; error?: string }>("voice.speakerEnrollmentFinish", {
					audio,
					sampleRate: 16_000,
				});
				if (current !== generation.current) return;
				if (!result.ok) {
					setError(result.error ?? tLoose("Try the verification again"));
					setPhase("error");
					return;
				}
				setPhase("complete");
				onChanged?.();
			}
		} catch (cause) {
			if (current !== generation.current) return;
			recorder.current = null;
			setPhase("error");
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	const remove = async (): Promise<void> => {
		if (!rpc) return;
		try {
			await rpc.request("voice.speakerDelete", {});
			setCount(0);
			setError("");
			setPhase("idle");
			onChanged?.();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setPhase("error");
		}
	};

	const status =
		phase === "preparing"
			? tLoose("Preparing microphone…")
			: phase === "recording"
				? tLoose("Listening — read at your natural pace")
				: phase === "processing"
					? tLoose("Processing this clip…")
					: phase === "accepted"
						? tLoose("Clip accepted")
						: phase === "complete"
							? tLoose("Voice enrolled")
							: phase === "error"
								? tLoose("Try again")
								: count === 4
									? tLoose("Read one new phrase to verify your voice")
									: tLoose("Ready when you are");
	const icon =
		phase === "complete" || phase === "accepted"
			? Check
			: phase === "error"
				? CircleAlert
				: phase === "preparing" || phase === "processing"
					? LoaderCircle
					: Mic;

	return (
		<DialogFrame
			open={open}
			onClose={cancel}
			label={tLoose("Voice enrollment")}
			className="gui-dialog--settings gui-voice-enroll"
		>
			<HeightMorph morphKey={`${count}:${phase}`} className="gui-voice-enroll-body">
				<div className="gui-voice-enroll-heading">
					{phase === "complete" ? tLoose("Voice ready") : tLoose("Your voice")}
				</div>
				<div
					className="gui-voice-enroll-stage"
					data-state={phase}
					style={{ "--enroll-level": phase === "recording" ? level : 0 } as CSSProperties}
				>
					<svg className="gui-voice-enroll-ring" viewBox="0 0 120 120" aria-hidden="true">
						<circle className="gui-voice-enroll-ring-track" cx="60" cy="60" r="55" pathLength="100" />
						<circle
							className="gui-voice-enroll-ring-value"
							cx="60"
							cy="60"
							r="55"
							pathLength="100"
							style={{ strokeDasharray: `${(count / 4) * 100} 100` }}
						/>
					</svg>
					<div className="gui-voice-enroll-orb" aria-hidden="true">
						<MorphIcon icon={icon} size={30} spring="snappy" />
					</div>
				</div>
				<div
					className="gui-voice-enroll-progress"
					role="progressbar"
					aria-label={tLoose("Voice enrollment")}
					aria-valuemin={0}
					aria-valuemax={4}
					aria-valuenow={count}
					aria-valuetext={`${count} / 4`}
				>
					{PROMPTS.slice(0, 4).map((_, index) => (
						<i key={index} data-complete={index < count} />
					))}
				</div>
				<div className="gui-voice-enroll-copy" key={`${count}:${phase === "complete" ? "complete" : "prompt"}`}>
					<p className="gui-voice-enroll-state" role="status" aria-live="polite">
						{status}
					</p>
					{phase !== "complete" && (
						<p className="gui-voice-enroll-instruction">
							{count === 4
								? tLoose("Read one new phrase to verify your voice")
								: tLoose("Read this phrase aloud")}
						</p>
					)}
					<p className="gui-voice-enroll-prompt">
						{phase === "complete"
							? tLoose("Only your voiceprint is stored on this device.")
							: tLoose(PROMPTS[count] ?? PROMPTS[0]!)}
					</p>
				</div>
				<div className="gui-voice-enroll-feedback">
					<Reveal open={Boolean(error)} className="gui-voice-enroll-error">
						<p role="alert">{error}</p>
					</Reveal>
				</div>
				<div className="gui-voice-enroll-actions">
					{phase !== "complete" && (
						<button type="button" className="gui-btn" onClick={cancel}>
							{tLoose("Cancel")}
						</button>
					)}
					{(phase === "complete" || hasProfile) && (
						<button type="button" className="gui-btn" onClick={() => void remove()}>
							{tLoose("Delete voiceprint")}
						</button>
					)}
					<button
						type="button"
						className="gui-btn gui-btn--primary gui-voice-enroll-primary"
						disabled={!rpc || phase === "preparing" || phase === "processing"}
						onClick={phase === "complete" ? onClose : () => void record()}
					>
						{phase === "recording"
							? tLoose("Finish")
							: phase === "preparing" || phase === "processing"
								? "…"
								: phase === "error"
									? tLoose("Try again")
									: phase === "complete"
										? tLoose("Finish")
										: count === 0
											? tLoose("Start")
											: tLoose("Continue")}
					</button>
				</div>
			</HeightMorph>
		</DialogFrame>
	);
}
