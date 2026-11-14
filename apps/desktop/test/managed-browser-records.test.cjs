const { afterEach, describe, expect, it } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ManagedBrowserRecordStore } = require("../electron/managed-browser-records.cjs");

const temporaryDirs = [];
function storeFile(name = "records.json") {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-browser-records-"));
	temporaryDirs.push(dir);
	return path.join(dir, name);
}

afterEach(() => {
	for (const dir of temporaryDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("managed browser record store", () => {
	it("persists history and download progress newest first", () => {
		const file = storeFile();
		const store = new ManagedBrowserRecordStore(file);
		store.recordHistory({ url: "https://example.test/older", title: "Older", visitedAt: 100 });
		store.recordHistory({ url: "https://example.test/newer", title: "Newer", visitedAt: 200 });
		const download = store.beginDownload({
			url: "https://example.test/file.zip",
			fileName: "file.zip",
			totalBytes: 100,
			startedAt: 300,
		});
		store.updateDownload(download.id, { receivedBytes: 40, totalBytes: 100 });
		store.updateDownload(download.id, { status: "completed", receivedBytes: 100, totalBytes: 100, endedAt: 400 });

		const reloaded = new ManagedBrowserRecordStore(file);
		expect(reloaded.history().map(record => record.title)).toEqual(["Newer", "Older"]);
		expect(reloaded.history()[0].visitedAt).toBe(200);
		expect(reloaded.downloads()[0]).toMatchObject({
			url: "https://example.test/file.zip",
			fileName: "file.zip",
			status: "completed",
			receivedBytes: 100,
			totalBytes: 100,
			startedAt: 300,
			endedAt: 400,
		});
		expect(Object.hasOwn(reloaded.downloads()[0], "savePath")).toBe(false);
	});

	it("caps history at 200 and downloads at 100 while dropping the oldest", () => {
		const store = new ManagedBrowserRecordStore(storeFile());
		for (let index = 0; index < 205; index++) {
			store.recordHistory({ url: `https://example.test/${index}`, title: `Page ${index}`, visitedAt: index });
		}
		for (let index = 0; index < 105; index++) {
			store.beginDownload({
				url: `https://example.test/${index}.bin`,
				fileName: `${index}.bin`,
				totalBytes: 0,
				startedAt: index,
			});
		}
		expect(store.history()).toHaveLength(200);
		expect(store.history()[0].title).toBe("Page 204");
		expect(store.history().at(-1).title).toBe("Page 5");
		expect(store.downloads()).toHaveLength(100);
		expect(store.downloads()[0].fileName).toBe("104.bin");
		expect(store.downloads().at(-1).fileName).toBe("5.bin");
	});

	it("ignores malformed persisted records without inventing authoritative data", () => {
		const file = storeFile();
		fs.writeFileSync(file, JSON.stringify({ unexpected: true }));
		expect(new ManagedBrowserRecordStore(file).history()).toEqual([]);
		fs.writeFileSync(file, "{not-json");
		expect(new ManagedBrowserRecordStore(file).downloads()).toEqual([]);
	});

	it("keeps a savePath when supplied and ignores unknown download updates", () => {
		const store = new ManagedBrowserRecordStore(storeFile());
		const download = store.beginDownload({
			url: "https://example.test/report.pdf",
			fileName: "report.pdf",
			savePath: "/tmp/report.pdf",
			totalBytes: 0,
			startedAt: 100,
		});
		store.updateDownload("missing", { status: "completed", receivedBytes: 1 });
		expect(store.downloads()[0].savePath).toBe("/tmp/report.pdf");
		expect(store.downloads()[0].status).toBe("progressing");
	});
});
