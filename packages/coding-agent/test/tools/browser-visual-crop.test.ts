import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import type { ToolSession } from "@musepi/pi-coding-agent/sdk";
import { BrowserTool } from "@musepi/pi-coding-agent/tools/browser";
import { createVisualSnapshot } from "@musepi/pi-coding-agent/tools/browser/snapshots";
import * as supervisor from "@musepi/pi-coding-agent/tools/browser/tab-supervisor";
import { resolveVisualCrop } from "@musepi/pi-coding-agent/tools/browser/visual-crop";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwoADw4PvL9VxQAAAABJRU5ErkJggg==";
const temporaryDirs: string[] = [];

function makeSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

function snapshot(dest: string) {
	return createVisualSnapshot("docs", {
		url: "https://example.test",
		title: "Example",
		viewport: { width: 100, height: 50 },
		image: { dest, mimeType: "image/png", bytes: 100, width: 100, height: 50 },
		capturedAt: "2026-11-08T00:00:00.000Z",
	});
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(temporaryDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("visual crop", () => {
	it("scales returned-image regions into original capture pixels", () => {
		const source = resolveVisualCrop(snapshot("shot.png"), { x: 10, y: 5, width: 20, height: 10 }, 200, 100);
		expect(source).toEqual({ left: 20, top: 10, width: 40, height: 20 });
		expect(() => resolveVisualCrop(snapshot("shot.png"), { x: 90, y: 0, width: 20, height: 10 }, 200, 100)).toThrow(
			/region/i,
		);
	});

	it("returns the source snapshot, crop metadata and actual image content", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-crop-test-"));
		temporaryDirs.push(dir);
		const dest = path.join(dir, "source.png");
		await Bun.write(dest, Buffer.from(PNG, "base64"));
		const current = createVisualSnapshot("docs", {
			url: "https://example.test",
			title: "Example",
			viewport: { width: 1, height: 1 },
			image: { dest, mimeType: "image/png", bytes: 1, width: 1, height: 1 },
			capturedAt: "2026-11-08T00:00:00.000Z",
		});
		vi.spyOn(supervisor, "getTab").mockReturnValue({
			targetId: "PAGE1",
			info: { url: "https://example.test", title: "Example", targetId: "PAGE1", viewport: { width: 1, height: 1 } },
			browser: { kind: { kind: "connected", gui: true } },
		} as never);
		vi.spyOn(supervisor, "runInTab").mockResolvedValue({
			displays: [],
			returnValue: { data: PNG },
			screenshots: [],
			operations: [],
		});
		const result = await new BrowserTool(makeSession()).execute("crop", {
			action: "visual_crop",
			name: "docs",
			snapshotId: current.snapshotId,
			region: { x: 0, y: 0, width: 1, height: 1 },
		});
		expect(result.details?.visualCrop).toMatchObject({
			sourceSnapshotId: current.snapshotId,
			region: { x: 0, y: 0, width: 1, height: 1 },
			capturedAt: current.capturedAt,
			image: { mimeType: "image/png", width: 1, height: 1 },
		});
		expect(result.content).toContainEqual({ type: "image", data: PNG, mimeType: "image/png" });
		expect(result.content.some(item => item.type === "text" && item.text.includes(current.snapshotId))).toBe(true);
	});
});
