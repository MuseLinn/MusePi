import type { SttModelKey } from "../../stt/models";
import type { GateState, SpeakerMode } from "./gate";

export interface FrontendProcessInput {
	audio: Float32Array;
	sampleRate: 16_000;
	targetMs: number;
	speakerMode: SpeakerMode;
	enhanceAudio: boolean;
	enrollment: number[][];
	acceptThreshold: number;
	rejectThreshold: number;
}

export interface FrontendProcessResult {
	segmentId: number;
	audio: Float32Array;
	state: GateState;
	score: number | null;
	enhanced: boolean;
}

export interface FrontendStreamResult extends FrontendProcessResult {
	text: string;
}

export interface VoiceFrontendStreamOptions extends Omit<FrontendProcessInput, "audio" | "sampleRate" | "targetMs"> {
	modelKey: SttModelKey;
	language?: string;
	onPartial?(result: FrontendStreamResult): void;
	onSegment?(result: FrontendStreamResult): void;
}

export interface VoiceFrontendStreamHandle {
	pushAudio(samples: Float32Array): void;
	stop(): Promise<FrontendStreamResult[]>;
	cancel(): void;
}

export type VoiceFrontendRequest =
	| { type: "ping" }
	| ({ type: "process" } & FrontendProcessInput)
	| { type: "embed"; audio: Float32Array; sampleRate: 16_000 };

export type VoiceFrontendWorkerInbound =
	| { type: "ping"; id: string }
	| ({ type: "process"; id: string } & FrontendProcessInput)
	| { type: "embed"; id: string; audio: Float32Array; sampleRate: 16_000 };

export type VoiceFrontendWorkerOutbound =
	| { type: "pong"; id: string }
	| ({ type: "result"; id: string } & FrontendProcessResult)
	| { type: "embedding"; id: string; embedding: Float32Array }
	| { type: "error"; id: string; error: string };

export interface VoiceFrontendTransport {
	send(message: VoiceFrontendWorkerInbound): void;
	onMessage(handler: (message: VoiceFrontendWorkerOutbound) => void): () => void;
	terminate(): void | Promise<void>;
}
