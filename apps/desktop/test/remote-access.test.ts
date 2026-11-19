import { describe, expect, test } from "bun:test";
import { channelStateText } from "../src/lib/remote-access";

describe("channelStateText", () => {
	test("prioritizes live connection states over secondary details", () => {
		expect(channelStateText("connected", "2 chats")).toBe("connected");
		expect(channelStateText("connecting", undefined)).toBe("connecting");
		expect(channelStateText("waiting_scan", "Scan with WeChat")).toBe("waiting");
	});

	test("keeps actionable details and removes redundant off copy", () => {
		expect(channelStateText("off", "Token required")).toBe("detail");
		expect(channelStateText("off", undefined)).toBe("off");
		expect(channelStateText("error", undefined)).toBe("off");
	});
});
