// ============================================================
// config/schema.ts tests — settings merge gates (updateCheck, compat)
// ============================================================

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeMusepiSettings, MUSEPI_SETTINGS_DOCS } from "../src/config/schema.ts";

describe("mergeMusepiSettings updateCheck gate", () => {
	it("defaults to on (MusePi has its own GitHub Releases channel)", () => {
		assert.equal(mergeMusepiSettings(undefined).updateCheck, true);
		assert.equal(mergeMusepiSettings({}).updateCheck, true);
	});

	it("respects an explicit opt-out", () => {
		assert.equal(mergeMusepiSettings({ updateCheck: false }).updateCheck, false);
		assert.equal(mergeMusepiSettings({ updateCheck: true }).updateCheck, true);
	});

	it("falls back to the default on mistyped values", () => {
		assert.equal(mergeMusepiSettings({ updateCheck: "yes" as never }).updateCheck, true);
	});
});

describe("mergeMusepiSettings compat.loadPiExtensions gate", () => {
	it("defaults to off (pi extensions can collide with native features)", () => {
		assert.equal(mergeMusepiSettings(undefined).compat.loadPiExtensions, false);
		assert.equal(mergeMusepiSettings({ compat: {} }).compat.loadPiExtensions, false);
	});

	it("respects an explicit opt-in", () => {
		assert.equal(mergeMusepiSettings({ compat: { loadPiExtensions: true } }).compat.loadPiExtensions, true);
	});

	it("falls back to the default on mistyped values", () => {
		assert.equal(
			mergeMusepiSettings({ compat: { loadPiExtensions: "yes" as never } }).compat.loadPiExtensions,
			false,
		);
		assert.equal(mergeMusepiSettings({ compat: 42 as never }).compat.loadPiExtensions, false);
	});
});

describe("MUSEPI_SETTINGS_DOCS", () => {
	it("documents both gates with their defaults", () => {
		const updateCheck = MUSEPI_SETTINGS_DOCS.find((d) => d.key === "updateCheck");
		const compat = MUSEPI_SETTINGS_DOCS.find((d) => d.key === "compat.loadPiExtensions");
		assert.ok(updateCheck, "updateCheck doc entry");
		assert.equal(updateCheck.defaultValue, true);
		assert.ok(compat, "compat.loadPiExtensions doc entry");
		assert.equal(compat.defaultValue, false);
	});
});
