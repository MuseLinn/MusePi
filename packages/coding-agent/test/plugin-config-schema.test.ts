/**
 * Contract tests for a plugin's declared `Config` (dsh's Standard Schema):
 * validation, defaults, rejection, and the generated form sidecar.
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { readExtensionPluginMeta } from "../src/extensibility/extensions/plugin-manifest";
import { validateDeclaredPluginConfig } from "../src/extensibility/plugins/runtime/declared-config";

const ENTRY = path.resolve(import.meta.dir, "../src/plugins/workspace/compaction-tiers/index.ts");

function schema(validate: (value: unknown) => unknown) {
	return { "~standard": { version: 1, vendor: "test", validate } };
}

describe("plugin Config validation", () => {
	test("uses the schema output, so defaults and transformations apply", async () => {
		const Config = schema(value => ({ value: { ...(value as object), defaulted: true } }));
		expect(await validateDeclaredPluginConfig({ Config }, { answer: 42 })).toEqual({
			answer: 42,
			defaulted: true,
		});
	});

	test("refuses values the schema rejects", async () => {
		const Config = schema(() => ({ issues: [{ message: "capPercent must be below 100" }] }));
		await expect(validateDeclaredPluginConfig({ Config }, { capPercent: 120 })).rejects.toThrow(
			"capPercent must be below 100",
		);
	});

	test("a Config that is not a Standard Schema is refused, not skipped", async () => {
		await expect(validateDeclaredPluginConfig({ Config: {} }, {})).rejects.toThrow("Standard Schema");
	});

	test("an entry without Config passes its values through", async () => {
		expect(await validateDeclaredPluginConfig({}, { answer: 42 })).toEqual({ answer: 42 });
	});
});

describe("generated config sidecar", () => {
	test("the manifest reads the schema-derived sidecar", async () => {
		const meta = await readExtensionPluginMeta(ENTRY);
		expect(meta?.fields).toHaveLength(1);
		expect(meta?.fields[0]).toMatchObject({
			key: "capPercent",
			type: "number",
			default: 70,
			restart: "session",
		});
	});
});
