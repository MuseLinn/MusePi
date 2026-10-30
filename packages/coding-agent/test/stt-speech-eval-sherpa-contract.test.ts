import { describe, expect, it } from "bun:test";
import { cosineSimilarity, createSherpaSpeakerVerifier } from "@musepi/pi-coding-agent/stt/eval/speaker-verifier";
import type { SherpaRuntime, SherpaSpeakerEmbeddingStream } from "@musepi/pi-coding-agent/stt/sherpa-runtime";

interface FakeStream extends SherpaSpeakerEmbeddingStream {
	samples: Float32Array | null;
	finished: boolean;
}

function fakeRuntime(): { runtime: SherpaRuntime; state: { extractorLoads: number; recognizerCloses: number } } {
	const state = { extractorLoads: 0, recognizerCloses: 0 };
	class SpeakerEmbeddingExtractor {
		readonly dim = 2;
		constructor(readonly config: { model: string }) {
			state.extractorLoads++;
		}
		createStream(): FakeStream {
			return {
				samples: null,
				finished: false,
				acceptWaveform(audio) {
					this.samples = audio.samples;
				},
				inputFinished() {
					this.finished = true;
				},
			};
		}
		isReady(stream: SherpaSpeakerEmbeddingStream): boolean {
			return (stream as FakeStream).finished;
		}
		compute(): Float32Array {
			return new Float32Array([3, 4]);
		}
	}
	return {
		state,
		runtime: {
			Vad: class {
				acceptWaveform(): void {}
				isEmpty(): boolean {
					return true;
				}
				front(): { start: number; samples: Float32Array } {
					return { start: 0, samples: new Float32Array() };
				}
				pop(): void {}
				flush(): void {}
				reset(): void {}
			},
			OnlineSpeechDenoiser: class {
				readonly sampleRate = 16_000;
				readonly frameShiftInSamples = 160;
				run(audio: { samples: Float32Array; sampleRate: number }): { samples: Float32Array; sampleRate: number } {
					return audio;
				}
				flush(): { samples: Float32Array; sampleRate: number } {
					return { samples: new Float32Array(), sampleRate: 16_000 };
				}
				reset(): void {}
			},
			SpeakerEmbeddingExtractor,
			OfflineRecognizer: {
				async createAsync() {
					return {
						createStream: () => ({ acceptWaveform: () => {} }),
						setConfig: () => {},
						decodeAsync: async () => ({}),
					};
				},
			},
			OfflineTts: {
				async createAsync() {
					return {
						sampleRate: 24_000,
						generate: () => ({ samples: new Float32Array(), sampleRate: 24_000 }),
						generateAsync: async () => ({ samples: new Float32Array(), sampleRate: 24_000 }),
					};
				},
			},
		},
	};
}

describe("sherpa speaker verifier", () => {
	it("loads the extractor only on the first embedding", async () => {
		const { runtime, state } = fakeRuntime();
		const verifier = createSherpaSpeakerVerifier({ runtime, modelPath: "speaker.onnx", numThreads: 1 });
		expect(state.extractorLoads).toBe(0);

		const embedding = await verifier.embed({ samples: new Float32Array([0.1, 0.2]), sampleRate: 16_000 });

		expect(state.extractorLoads).toBe(1);
		expect(embedding[0]).toBeCloseTo(0.6);
		expect(embedding[1]).toBeCloseTo(0.8);
		await verifier.close();
	});

	it("closes and recreates only the speaker extractor", async () => {
		const { runtime, state } = fakeRuntime();
		const verifier = createSherpaSpeakerVerifier({ runtime, modelPath: "speaker.onnx", numThreads: 1 });
		await verifier.embed({ samples: new Float32Array([0.1]), sampleRate: 16_000 });
		await verifier.close();
		expect(state.recognizerCloses).toBe(0);

		await verifier.embed({ samples: new Float32Array([0.2]), sampleRate: 16_000 });
		expect(state.extractorLoads).toBe(2);
		await verifier.close();
	});

	it("compares normalized embeddings with cosine similarity", () => {
		expect(cosineSimilarity(new Float32Array([3, 4]), new Float32Array([3, 4]))).toBeCloseTo(1);
		expect(cosineSimilarity(new Float32Array([3, 4]), new Float32Array([-3, -4]))).toBeCloseTo(-1);
	});
});
