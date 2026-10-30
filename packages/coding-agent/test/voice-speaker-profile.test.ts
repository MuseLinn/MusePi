import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createSpeakerProfileStore } from "@musepi/pi-coding-agent/voice/frontend/profile";
import { removeWithRetries } from "@musepi/pi-utils";

let tmp = "";

afterEach(async () => {
	if (tmp) await removeWithRetries(tmp);
	tmp = "";
});

function embedder(values?: { inconsistent?: boolean; lowScore?: boolean }) {
	return async (audio: Float32Array): Promise<Float32Array> => {
		if (values?.inconsistent && audio[0] === 3) return new Float32Array([-1, 0]);
		if (values?.lowScore) return new Float32Array([0.2, 0.8]);
		return new Float32Array([1, 0]);
	};
}

async function createStore(options: { inconsistent?: boolean; lowScore?: boolean } = {}) {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-speaker-profile-"));
	const profilePath = path.join(tmp, "speaker.json");
	return {
		profilePath,
		store: createSpeakerProfileStore({ profilePath, embed: embedder(options) }),
	};
}

function clip(seconds: number, marker = 0): Float32Array {
	return new Float32Array(Math.round(seconds * 16_000)).fill(marker);
}

async function enroll(store: ReturnType<typeof createSpeakerProfileStore>): Promise<void> {
	store.startEnrollment();
	for (let i = 0; i < 4; i++) {
		const result = await store.addEnrollmentSample(clip(4, i), 16_000);
		if (!result.accepted) throw new Error(result.reason);
	}
}

describe("speaker profile store", () => {
	it("accepts four clips and independent verification", async () => {
		const { store, profilePath } = await createStore();
		await enroll(store);
		const result = await store.finishEnrollment(clip(2), 16_000);
		expect(result.ok).toBe(true);
		expect(result.score).toBeCloseTo(1);
		const profile = await store.readSpeakerProfile();
		expect(profile?.samples).toHaveLength(4);
		expect(profile?.dimension).toBe(2);
		expect(profile?.acceptThreshold).toBe(0.7);
		const persisted = await Bun.file(profilePath).text();
		expect(persisted).not.toContain("pcm");
		expect(persisted).not.toContain("transcript");
	});

	it("rejects less than sixteen seconds of speech", async () => {
		const { store } = await createStore();
		store.startEnrollment();
		for (let i = 0; i < 3; i++) await store.addEnrollmentSample(clip(4, i), 16_000);
		const result = await store.finishEnrollment(clip(2), 16_000);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("16");
	});

	it("rejects an inconsistent clip without advancing the count", async () => {
		const { store } = await createStore({ inconsistent: true });
		store.startEnrollment();
		await store.addEnrollmentSample(clip(4, 1), 16_000);
		await store.addEnrollmentSample(clip(4, 2), 16_000);
		const result = await store.addEnrollmentSample(clip(4, 3), 16_000);
		expect(result.accepted).toBe(false);
		expect(result.count).toBe(2);
	});

	it("cancels enrollment while preserving the previous valid profile", async () => {
		const { store } = await createStore();
		await enroll(store);
		await store.finishEnrollment(clip(2), 16_000);
		store.startEnrollment();
		await store.addEnrollmentSample(clip(4, 4), 16_000);
		store.cancelEnrollment();
		expect((await store.readSpeakerProfile())?.samples).toHaveLength(4);
	});

	it("deletes the profile file", async () => {
		const { store } = await createStore();
		await enroll(store);
		await store.finishEnrollment(clip(2), 16_000);
		await store.deleteSpeakerProfile();
		expect(await store.readSpeakerProfile()).toBeNull();
	});
});
