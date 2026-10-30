import * as path from "node:path";
import { getAgentDir } from "@musepi/pi-utils";
import { createVoiceFrontendClient, type VoiceFrontendClient } from "./client";
import type { GateState, SpeakerMode } from "./gate";
import { createSpeakerProfileStore, type SpeakerProfileStore } from "./profile";
import type { FrontendProcessResult, FrontendStreamResult, VoiceFrontendStreamHandle } from "./protocol";

export interface VoiceSpeakerStatus {
	hasProfile: boolean;
	model: string | null;
	sampleCount: number;
	acceptThreshold: number | null;
	rejectThreshold: number | null;
}

export class VoiceFrontendService {
	readonly #client: VoiceFrontendClient;
	readonly #profiles: SpeakerProfileStore;
	readonly #streams = new Map<string, VoiceFrontendStreamHandle>();
	#nextStreamId = 0;

	constructor(client?: VoiceFrontendClient, profiles?: SpeakerProfileStore) {
		this.#client = client ?? createVoiceFrontendClient();
		this.#profiles =
			profiles ??
			createSpeakerProfileStore({
				profilePath: path.join(getAgentDir(), "voice", "speaker-profile.json"),
				embed: (audio, sampleRate) => this.#client.embed(audio, sampleRate),
			});
	}

	async status(): Promise<VoiceSpeakerStatus> {
		const profile = await this.#profiles.readSpeakerProfile();
		return {
			hasProfile: profile !== null,
			model: profile?.model ?? null,
			sampleCount: profile?.samples.length ?? 0,
			acceptThreshold: profile?.acceptThreshold ?? null,
			rejectThreshold: profile?.rejectThreshold ?? null,
		};
	}

	enrollmentStart(): { count: number; totalMs: number } {
		return this.#profiles.startEnrollment();
	}

	async enrollmentAdd(input: {
		audio: number[];
		sampleRate: 16_000;
	}): Promise<{ accepted: boolean; reason?: string; count: number }> {
		return this.#profiles.addEnrollmentSample(Float32Array.from(input.audio), input.sampleRate);
	}

	async enrollmentFinish(input: {
		audio: number[];
		sampleRate: 16_000;
	}): Promise<{ ok: boolean; score?: number; error?: string }> {
		return this.#profiles.finishEnrollment(Float32Array.from(input.audio), input.sampleRate);
	}

	enrollmentCancel(): void {
		this.#profiles.cancelEnrollment();
	}

	async speakerDelete(): Promise<void> {
		await this.#profiles.deleteSpeakerProfile();
	}

	async process(input: {
		audio: Float32Array;
		sampleRate: 16_000;
		targetMs: number;
		speakerMode: SpeakerMode;
		enhanceAudio: boolean;
		enrollment?: number[][];
		acceptThreshold?: number;
		rejectThreshold?: number;
	}): Promise<FrontendProcessResult> {
		const profile = input.speakerMode === "off" ? null : await this.#profiles.readSpeakerProfile();
		return this.#client.process({
			...input,
			enrollment: input.enrollment ?? profile?.samples ?? [],
			acceptThreshold: input.acceptThreshold ?? profile?.acceptThreshold ?? 0.7,
			rejectThreshold: input.rejectThreshold ?? profile?.rejectThreshold ?? 0.5,
		});
	}

	async streamStart(
		options: Omit<
			Parameters<VoiceFrontendClient["startStream"]>[0],
			"onPartial" | "onSegment" | "enrollment" | "acceptThreshold" | "rejectThreshold"
		> & { enrollment?: number[][]; acceptThreshold?: number; rejectThreshold?: number },
		events?: { onPartial?(result: FrontendStreamResult): void; onSegment?(result: FrontendStreamResult): void },
	): Promise<string> {
		const profile = options.speakerMode === "off" ? null : await this.#profiles.readSpeakerProfile();
		const sessionId = `voice-${++this.#nextStreamId}`;
		this.#streams.set(
			sessionId,
			this.#client.startStream({
				...options,
				enrollment: options.enrollment ?? profile?.samples ?? [],
				acceptThreshold: options.acceptThreshold ?? profile?.acceptThreshold ?? 0.7,
				rejectThreshold: options.rejectThreshold ?? profile?.rejectThreshold ?? 0.5,
				...events,
			}),
		);
		return sessionId;
	}

	streamAudio(sessionId: string, samples: Float32Array): void {
		this.#stream(sessionId).pushAudio(samples);
	}

	async streamStop(sessionId: string): Promise<FrontendStreamResult[]> {
		const stream = this.#stream(sessionId);
		this.#streams.delete(sessionId);
		return stream.stop();
	}

	streamCancel(sessionId: string): void {
		const stream = this.#streams.get(sessionId);
		if (!stream) return;
		this.#streams.delete(sessionId);
		stream.cancel();
	}

	close(): void {
		for (const stream of this.#streams.values()) stream.cancel();
		this.#streams.clear();
		this.#client.close();
	}

	#stream(sessionId: string): VoiceFrontendStreamHandle {
		const stream = this.#streams.get(sessionId);
		if (!stream) throw new Error(`Unknown voice stream ${sessionId}`);
		return stream;
	}
}

let service: VoiceFrontendService | null = null;

export function getVoiceFrontendService(): VoiceFrontendService {
	service ??= new VoiceFrontendService();
	return service;
}

export type { GateState, SpeakerMode };
