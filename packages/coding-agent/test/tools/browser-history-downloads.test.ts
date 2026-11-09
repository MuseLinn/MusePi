import { describe, expect, it } from "bun:test";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import type { ToolSession } from "@musepi/pi-coding-agent/sdk";
import { BrowserTool } from "@musepi/pi-coding-agent/tools/browser";
import { readManagedBrowserRecords } from "@musepi/pi-coding-agent/tools/browser/state";

function makeSession(guiUrl?: string): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: guiUrl ? Settings.isolated({ "browser.gui": true, "browser.guiUrl": guiUrl }) : Settings.isolated(),
	};
}

const history = [{ id: "h2", url: "https://example.test/newer", title: "Newer", visitedAt: 200 }];
const downloads = [
	{
		id: "d2",
		url: "https://example.test/file.zip",
		fileName: "file.zip",
		savePath: "/tmp/file.zip",
		status: "completed",
		receivedBytes: 100,
		totalBytes: 100,
		startedAt: 300,
		endedAt: 400,
	},
];

describe("browser history and download records", () => {
	it("reads the managed profile records through loopback", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: request => {
				const pathname = new URL(request.url).pathname;
				if (pathname === "/musepi/history") return Response.json(history);
				if (pathname === "/musepi/downloads") return Response.json(downloads);
				return new Response("not found", { status: 404 });
			},
		});
		try {
			const base = `http://127.0.0.1:${server.port}`;
			expect(await readManagedBrowserRecords(base, "history")).toEqual(history);
			expect(await readManagedBrowserRecords(base, "downloads")).toEqual(downloads);
			const tool = new BrowserTool(makeSession(base));
			const historyResult = await tool.execute("history", { action: "history" });
			const downloadResult = await tool.execute("downloads", { action: "downloads" });
			expect(historyResult.details?.history).toEqual(history);
			expect(downloadResult.details?.downloads).toEqual(downloads);
		} finally {
			server.stop(true);
		}
	});

	it("requires the managed Electron profile instead of inventing headless records", async () => {
		await expect(new BrowserTool(makeSession()).execute("history", { action: "history" })).rejects.toThrow(
			/managed Electron browser profile/,
		);
		await expect(new BrowserTool(makeSession()).execute("downloads", { action: "downloads" })).rejects.toThrow(
			/managed Electron browser profile/,
		);
	});
});
