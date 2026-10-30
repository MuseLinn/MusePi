import { tLoose } from "@musepi/client-core";
import { Check, Mic } from "lucide";
import { MorphIcon } from "morphicons/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
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
	const [phase, setPhase] = useState<"idle" | "recording" | "processing" | "complete">("idle");
	const [error, setError] = useState("");
	const recorder = useRef<EnrollmentCapture | null>(null);
	const generation = useRef(0);
	const wasOpen = useRef(open);

	const cancel = (): void => {
		generation.current += 1;
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
			recorder.current?.stop();
		},
		[],
	);

	const record = async (): Promise<void> => {
		if (!rpc || phase === "processing") return;
		if (phase === "recording") {
			recorder.current?.stop();
			return;
		}
		const current = generation.current;
		setError("");
		setLevel(0);
		try {
			if (count === 0 && phase !== "complete") await rpc.request("voice.speakerEnrollmentStart", {});
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
					setPhase("idle");
					return;
				}
				setCount(value => value + 1);
				setPhase("idle");
			} else {
				const result = await rpc.request<{ ok: boolean; error?: string }>("voice.speakerEnrollmentFinish", {
					audio,
					sampleRate: 16_000,
				});
				if (current !== generation.current) return;
				if (!result.ok) {
					setError(result.error ?? tLoose("Try the verification again"));
					setPhase("idle");
					return;
				}
				setPhase("complete");
				onChanged?.();
			}
		} catch (cause) {
			if (current !== generation.current) return;
			recorder.current = null;
			setPhase("idle");
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	const remove = async (): Promise<void> => {
		if (!rpc) return;
		await rpc.request("voice.speakerDelete", {});
		setCount(0);
		setPhase("idle");
		onChanged?.();
	};

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
					className="gui-voice-enroll-orb"
					style={{ "--enroll-level": phase === "recording" ? level : 0 } as React.CSSProperties}
					aria-hidden
				>
					<MorphIcon icon={phase === "complete" ? Check : Mic} size={28} spring="snappy" />
				</div>
				<div
					className="gui-voice-enroll-progress"
					role="progressbar"
					aria-label={tLoose("Voice enrollment")}
					aria-valuemin={0}
					aria-valuemax={4}
					aria-valuenow={count}
				>
					{PROMPTS.slice(0, 4).map((_, index) => (
						<i key={index} data-complete={index < count} />
					))}
				</div>
				<p className="gui-voice-enroll-prompt">
					{phase === "complete"
						? tLoose("Only your voiceprint is stored on this device.")
						: tLoose(PROMPTS[count] ?? PROMPTS[0]!)}
				</p>
				<Reveal open={Boolean(error)} className="gui-voice-enroll-error">
					<p role="alert">{error}</p>
				</Reveal>
				<div className="gui-voice-enroll-actions">
					<button type="button" className="gui-btn" onClick={cancel}>
						{tLoose("Cancel")}
					</button>
					{(phase === "complete" || hasProfile) && (
						<button type="button" className="gui-btn" onClick={() => void remove()}>
							{tLoose("Delete voiceprint")}
						</button>
					)}
					{phase !== "complete" && (
						<button
							type="button"
							className="gui-btn gui-btn--primary gui-voice-enroll-primary"
							disabled={!rpc || phase === "processing"}
							onClick={() => void record()}
						>
							{phase === "recording"
								? tLoose("Finish")
								: phase === "processing"
									? "…"
									: count === 0
										? tLoose("Start")
										: tLoose("Continue")}
						</button>
					)}
				</div>
			</HeightMorph>
		</DialogFrame>
	);
}
