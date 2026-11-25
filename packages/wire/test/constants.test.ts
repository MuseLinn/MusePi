import { describe, expect, it } from "bun:test";
import {
	COLLAB_PROMPT_MESSAGE_TYPE,
	COLLAB_PROTO,
	DEFAULT_RELAY_URL,
	DEFAULT_SHARE_URL,
	ENVELOPE_HEADER_LENGTH,
	ROOM_ID_BYTES,
} from "../src";

describe("collab wire constants", () => {
	it("exports the protocol constants consumed by host, guest, and relay links", () => {
		expect(COLLAB_PROTO).toBe(3);
		expect(COLLAB_PROMPT_MESSAGE_TYPE).toBe("collab-prompt");
		expect(ENVELOPE_HEADER_LENGTH).toBe(4);
		expect(ROOM_ID_BYTES).toBe(16);
	});

	it("ships no default relay or share server", () => {
		// Both used to name a third-party service inherited from the upstream
		// project, which made an unconfigured share send sealed traffic to a
		// host this project neither operates nor has an agreement with. An empty
		// default forces an explicit choice instead of a silent one.
		expect(DEFAULT_RELAY_URL).toBe("");
		expect(DEFAULT_SHARE_URL).toBe("");
	});
});
