/**
 * Plugin config form contract.
 *
 * `settingsScope` (bare get/set) has no answer to the two questions a real form
 * asks, and these are the answers:
 *
 * - **Did I lose a race?** A write carrying a stale revision is REFUSED and
 *   reports false, instead of silently clobbering a newer value.
 * - **Is this value mine or inherited?** The user layer holds only keys the user
 *   set. Key PRESENCE marks an override — a user setting a field to its declared
 *   default is still an override, and value comparison cannot see that. `unset`
 *   removes the key so the field re-inherits.
 *
 * Also pinned: clamping walks only the keys supplied. Filling in every declared
 * field would put keys where the user set nothing, which destroys the presence
 * semantics above — that was the trap in reusing `coerceConfigValues` here.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ConfigFieldDesc } from "@musepi/pi-wire";
import { createPluginConfigForm } from "./plugin-config-form";
import { resetPluginConfigStoreCache } from "./plugin-config-store";

let dir: string;
let storePath: string;

const fields: ConfigFieldDesc[] = [
	{ key: "retries", type: "number", label: "Retries", default: 3 },
	{ key: "label", type: "string", label: "Label", default: "auto" },
] as unknown as ConfigFieldDesc[];

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-form-"));
	storePath = path.join(dir, "plugin-config.json");
	fs.writeFileSync(storePath, JSON.stringify({}), "utf8");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	resetPluginConfigStoreCache();
});

describe("createPluginConfigForm", () => {
	it("exposes the manifest defaults as the base and an empty user layer", async () => {
		const form = await createPluginConfigForm("plugin:a", fields, storePath);
		const snap = form.getSnapshot();

		expect(snap.status).toBe("ready");
		expect(snap.base).toEqual({ retries: 3, label: "auto" });
		// Nothing set yet — the user layer is empty, not a copy of the defaults.
		expect(snap.user).toEqual({});
		// Effective values compose over the base.
		expect(snap.value).toEqual({ retries: 3, label: "auto" });
	});

	it("records only the keys the user actually set", async () => {
		const form = await createPluginConfigForm("plugin:b", fields, storePath);

		await form.set("retries", 9);

		// Presence, not value: only `retries` is an override.
		expect(form.getSnapshot().user).toEqual({ retries: 9 });
		expect(form.getSnapshot().value).toEqual({ retries: 9, label: "auto" });
	});

	it("keeps an override that equals the declared default", async () => {
		// The trap: a user setting a field to its default still overrode it.
		// Value comparison would report "unchanged" and lose that fact.
		const form = await createPluginConfigForm("plugin:c", fields, storePath);

		await form.set("retries", 3);

		expect(form.getSnapshot().user).toEqual({ retries: 3 });
	});

	it("clears a field back to inheritance on unset", async () => {
		const form = await createPluginConfigForm("plugin:d", fields, storePath);
		await form.set("retries", 9);
		expect(form.getSnapshot().value?.retries).toBe(9);

		await form.unset("retries");

		// The key is gone from the user layer, so the value re-inherits.
		expect(form.getSnapshot().user).toEqual({});
		expect(form.getSnapshot().value?.retries).toBe(3);
	});

	it("refuses a write carrying a stale revision", async () => {
		const form = await createPluginConfigForm("plugin:e", fields, storePath);
		const first = form.getSnapshot().revision;

		// Someone else writes first, advancing the namespace.
		await form.set("retries", 5);

		// A caller that had only read `first` must not clobber that write.
		expect(await form.mutate([{ kind: "set", field: "retries", value: 99 }], first)).toBe(false);
		expect(form.getSnapshot().value?.retries).toBe(5);
	});

	it("accepts a write fenced on the current revision", async () => {
		const form = await createPluginConfigForm("plugin:f", fields, storePath);

		const ok = await form.mutate([{ kind: "set", field: "retries", value: 7 }], form.getSnapshot().revision);

		expect(ok).toBe(true);
		expect(form.getSnapshot().value?.retries).toBe(7);
	});

	it("advances the revision on every accepted write", async () => {
		const form = await createPluginConfigForm("plugin:g", fields, storePath);
		const start = form.getSnapshot().revision ?? 0;

		await form.set("retries", 1);
		const mid = form.getSnapshot().revision ?? 0;
		await form.set("retries", 2);

		expect(mid).toBe(start + 1);
		expect(form.getSnapshot().revision).toBe(start + 2);
	});

	it("applies a batch atomically", async () => {
		const form = await createPluginConfigForm("plugin:h", fields, storePath);

		await form.mutate([
			{ kind: "set", field: "retries", value: 4 },
			{ kind: "set", field: "label", value: "mine" },
		]);

		expect(form.getSnapshot().value).toEqual({ retries: 4, label: "mine" });
	});

	it("drops a value whose type the field rejects, back to the default", async () => {
		const form = await createPluginConfigForm("plugin:i", fields, storePath);

		await form.set("retries", "not-a-number");

		// Clamped per the declared field: a bad value must not reach the store.
		expect(form.getSnapshot().value?.retries).toBe(3);
	});

	it("ignores a key the manifest does not declare", async () => {
		const form = await createPluginConfigForm("plugin:j", fields, storePath);

		await form.set("unknownField", "x");

		// No field can render or reset it, so it is not kept.
		expect(form.getSnapshot().user).toEqual({});
	});

	it("notifies subscribers when the snapshot changes", async () => {
		const form = await createPluginConfigForm("plugin:k", fields, storePath);
		let calls = 0;
		const unsubscribe = form.subscribe(() => {
			calls += 1;
		});

		await form.set("retries", 6);

		expect(calls).toBeGreaterThan(0);
		unsubscribe();
	});

	it("reports memory mode for an injected store path", async () => {
		// Not the host's own config dir, so nothing should claim these survive
		// a restart elsewhere.
		const form = await createPluginConfigForm("plugin:l", fields, storePath);

		expect(form.getSnapshot().mode).toBe("memory");
	});
});
