import { describe, expect, test } from "bun:test";
import { channelStateText, isCloudflaredMissing } from "../src/lib/remote-access";

describe("isCloudflaredMissing", () => {
	test("detects the daemon's missing-executable failure case-insensitively", () => {
		expect(isCloudflaredMissing("Cloudflared is not installed. Install it with your package manager.")).toBe(true);
	});

	test("does not misclassify an installed tunnel process failure", () => {
		expect(isCloudflaredMissing("cloudflared exited with code 1")).toBe(false);
		expect(isCloudflaredMissing("network unreachable")).toBe(false);
	});
});

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
