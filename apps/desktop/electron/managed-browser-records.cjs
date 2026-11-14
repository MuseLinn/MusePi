"use strict";

const fs = require("node:fs");
const path = require("node:path");

const HISTORY_LIMIT = 200;
const DOWNLOAD_LIMIT = 100;

function finite(value) {
	return typeof value === "number" && Number.isFinite(value);
}

function validHistory(record) {
	return record && typeof record.id === "string" && typeof record.url === "string" && typeof record.title === "string" && finite(record.visitedAt);
}

function validDownload(record) {
	return record &&
		typeof record.id === "string" &&
		typeof record.url === "string" &&
		typeof record.fileName === "string" &&
		typeof record.status === "string" &&
		finite(record.receivedBytes) &&
		finite(record.totalBytes) &&
		finite(record.startedAt) &&
		(record.savePath === undefined || typeof record.savePath === "string") &&
		(record.endedAt === undefined || finite(record.endedAt));
}

function readRecords(file) {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		return {
			history: Array.isArray(parsed?.history) ? parsed.history.filter(validHistory) : [],
			downloads: Array.isArray(parsed?.downloads) ? parsed.downloads.filter(validDownload) : [],
		};
	} catch {
		return { history: [], downloads: [] };
	}
}

class ManagedBrowserRecordStore {
	constructor(file) {
		this.file = file;
		const records = readRecords(file);
		this.historyEntries = records.history;
		this.downloadEntries = records.downloads;
		this.seq = this.historyEntries.length + this.downloadEntries.length;
	}

	nextId(prefix) {
		return `${prefix}-${Date.now()}-${++this.seq}`;
	}

	write() {
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		const temporary = `${this.file}.${process.pid}.tmp`;
		try {
			fs.writeFileSync(temporary, `${JSON.stringify({ history: this.historyEntries, downloads: this.downloadEntries }, null, 2)}\n`);
			fs.renameSync(temporary, this.file);
		} finally {
			fs.rmSync(temporary, { force: true });
		}
	}

	recordHistory(input) {
		const record = {
			id: this.nextId("history"),
			url: String(input.url),
			title: String(input.title ?? ""),
			visitedAt: finite(input.visitedAt) ? input.visitedAt : Date.now(),
		};
		this.historyEntries.unshift(record);
		this.historyEntries.length = Math.min(this.historyEntries.length, HISTORY_LIMIT);
		this.write();
		return { ...record };
	}

	beginDownload(input) {
		const record = {
			id: this.nextId("download"),
			url: String(input.url),
			fileName: String(input.fileName),
			...(typeof input.savePath === "string" && input.savePath ? { savePath: input.savePath } : {}),
			status: "progressing",
			receivedBytes: 0,
			totalBytes: finite(input.totalBytes) && input.totalBytes >= 0 ? input.totalBytes : 0,
			startedAt: finite(input.startedAt) ? input.startedAt : Date.now(),
		};
		this.downloadEntries.unshift(record);
		this.downloadEntries.length = Math.min(this.downloadEntries.length, DOWNLOAD_LIMIT);
		this.write();
		return { ...record };
	}

	updateDownload(id, input) {
		const index = this.downloadEntries.findIndex(record => record.id === id);
		if (index < 0) return;
		const current = this.downloadEntries[index];
		const next = {
			...current,
			...(typeof input.status === "string" ? { status: input.status } : {}),
			...(finite(input.receivedBytes) ? { receivedBytes: Math.max(0, input.receivedBytes) } : {}),
			...(finite(input.totalBytes) && input.totalBytes >= 0 ? { totalBytes: input.totalBytes } : {}),
			...(finite(input.endedAt) ? { endedAt: input.endedAt } : {}),
		};
		this.downloadEntries[index] = next;
		this.write();
		return { ...next };
	}

	history() {
		return this.historyEntries.map(record => ({ ...record }));
	}

	downloads() {
		return this.downloadEntries.map(record => ({ ...record }));
	}
}

module.exports = { ManagedBrowserRecordStore, HISTORY_LIMIT, DOWNLOAD_LIMIT };
