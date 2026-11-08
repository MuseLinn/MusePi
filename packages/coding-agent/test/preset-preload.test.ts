import { describe, expect, test } from "bun:test";
import { presetPreloadCwds } from "@musepi/pi-coding-agent/daemon/preset-preload";

describe("preset preload cwds", () => {
	test("primary first, then workspace roots and additional dirs, deduplicated", () => {
		expect(
			presetPreloadCwds("/daemon", [
				{ root: "/a", additionalDirs: ["/a/sub", "/daemon"] },
				{ root: "/b" },
				{ root: "/a" },
			]),
		).toEqual(["/daemon", "/a", "/a/sub", "/b"]);
	});

	test("a daemon with no registered workspaces still preloads its cwd", () => {
		expect(presetPreloadCwds("/daemon", [])).toEqual(["/daemon"]);
	});
});
