import { describe, expect, it } from "bun:test";
import { isVoiceFrontendStreamEvent } from "../src/index";

describe("voice frontend wire contract", () => {
	it("accepts partial and segment events", () => {
		expect(
			isVoiceFrontendStreamEvent({
				type: "voice.frontendPartial",
				sessionId: "voice-1",
				segmentId: 2,
				text: "hello",
				state: "uncertain",
			}),
		).toBe(true);
		expect(
			isVoiceFrontendStreamEvent({
				type: "voice.frontendSegment",
				sessionId: "voice-1",
				segmentId: 3,
				text: "world",
				state: "accept",
			}),
		).toBe(true);
	});

	it("rejects malformed events", () => {
		expect(isVoiceFrontendStreamEvent(null)).toBe(false);
		expect(
			isVoiceFrontendStreamEvent({
				type: "voice.frontendPartial",
				sessionId: "voice-1",
				segmentId: 0,
				text: "x",
				state: "unknown",
			}),
		).toBe(false);
		expect(
			isVoiceFrontendStreamEvent({
				type: "voice.frontendSegment",
				sessionId: "voice-1",
				segmentId: "0",
				text: "x",
				state: "accept",
			}),
		).toBe(false);
	});
});
