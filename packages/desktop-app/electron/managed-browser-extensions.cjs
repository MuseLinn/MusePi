"use strict";

const fs = require("node:fs");
const path = require("node:path");

function errorText(error) {
	return error instanceof Error ? error.message : String(error);
}

function readExtensionManifest(dir) {
	if (typeof dir !== "string" || !path.isAbsolute(dir)) throw new Error("Extension directory must be absolute");
	const manifestPath = path.join(dir, "manifest.json");
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Invalid extension manifest");
	if (!Number.isInteger(manifest.manifest_version) || manifest.manifest_version <= 0) {
		throw new Error("Extension manifest_version must be a positive integer");
	}
	if (typeof manifest.name !== "string" || !manifest.name.trim()) throw new Error("Extension name is required");
	if (typeof manifest.version !== "string" || !manifest.version.trim()) throw new Error("Extension version is required");
	if (manifest.permissions !== undefined && (!Array.isArray(manifest.permissions) || manifest.permissions.some(p => typeof p !== "string"))) {
		throw new Error("Extension permissions must be a string array");
	}
	return {
		path: dir,
		name: manifest.name.trim(),
		version: manifest.version.trim(),
		permissions: (manifest.permissions ?? []).filter(Boolean),
	};
}

function readExtensionRecords(file) {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(record =>
			record &&
			typeof record.id === "string" &&
			typeof record.name === "string" &&
			typeof record.version === "string" &&
			typeof record.path === "string" &&
			path.isAbsolute(record.path) &&
			Array.isArray(record.permissions),
		);
	} catch {
		return [];
	}
}

function writeExtensionRecords(file, records) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(records, null, 2)}\n`);
}

async function loadPersistedExtensions(session, file) {
	const records = readExtensionRecords(file);
	const loaded = [];
	const errors = [];
	for (const record of records) {
		try {
			const extension = await session.loadExtension(record.path);
			loaded.push({ ...record, id: extension.id });
		} catch (error) {
			errors.push(errorText(error));
		}
	}
	if (loaded.length > 0) writeExtensionRecords(file, loaded);
	return { loaded, errors };
}

function listManagedExtensions(session, file) {
	const records = readExtensionRecords(file);
	return session.getAllExtensions().map(extension => {
		const record = records.find(candidate => candidate.id === extension.id);
		return {
			id: extension.id,
			name: extension.name,
			version: extension.version,
			path: record?.path ?? "",
			permissions: record?.permissions ?? [],
		};
	});
}

module.exports = {
	readExtensionManifest,
	readExtensionRecords,
	writeExtensionRecords,
	loadPersistedExtensions,
	listManagedExtensions,
};
