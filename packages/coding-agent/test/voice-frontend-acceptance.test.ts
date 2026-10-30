import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { runVoiceFrontendSmoke } from "../scripts/voice-frontend-smoke";

const enabled = process.env.MUSEPI_VOICE_REAL_ACCEPTANCE === "1";
const corpusDir = process.env.VOICE_FRONTEND_CORPUS_DIR ?? path.resolve(".tmp/speech-frontend-eval/corpus");

describe("real voice frontend acceptance", () => {
	it.skipIf(!enabled)(
		"keeps non-target audio from auto-submitting and meets accuracy and latency budgets",
		async () => {
			const metrics = await runVoiceFrontendSmoke(corpusDir);
			expect(metrics.nonTargetAutoSubmit).toBe(false);
			expect(metrics.strictOtherState).not.toBe("accept");
			expect(metrics.shortState).toBe("uncertain");
			expect(metrics.offEnhancementApplied).toBe(true);
			expect(metrics.cleanRelativeCer).toBeLessThanOrEqual(0.02);
			expect(metrics.cleanRelativeWer).toBeLessThanOrEqual(0.02);
			expect(metrics.frontendRtf).toBeLessThanOrEqual(0.75);
			expect(metrics.tailP95Ms).toBeLessThanOrEqual(500);
			console.log(JSON.stringify(metrics));
		},
		300_000,
	);
});
