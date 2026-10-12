/**
 * pluginConfig.* RPC contract — the daemon side of a real settings form.
 *
 * The contract under test is the difference between `settingsScope` (bare
 * get/set) and a form: a caller whose read is out of date must be told its
 * write lost, and a form must be able to distinguish a user-set value from an
 * inherited one. Both are observable only from the outside, which is why these
 * go through the service rather than the form module.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ConfigFieldDesc } from "@musepi/pi-wire";
import { resetPluginConfigStoreCache } from "../../extensibility/extensions-center/plugin-config-store";
import { ExtensionService } from "./extension-service";

let dir: string;
let storePath: string;

const FIELDS = [
	{ key: "retries", type: "number", label: "Retries", default: 3 },
	{ key: "label", type: "string", label: "Label", default: "auto" },
] as unknown as ConfigFieldDesc[];

/** A service whose `plugin:demo` namespace declares the fields above. */
function service(): ExtensionService {
	return new ExtensionService({
		settings: () => null,
		ensureRegistry: async () => {},
		cwd: () => dir,
		webUrl: () => null,
		webPortFile: () => "",
		onChanged: () => {},
		// Injected so the test does not depend on a full extension scan.
		configFields: (namespace: string) => (namespace === "plugin:demo" ? FIELDS : []),
		// Isolate the store to a temp file instead of the host's own config.
		pluginConfigStorePath: () => storePath,
	});
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-config-rpc-"));
	storePath = path.join(dir, "plugin-config.json");
	fs.writeFileSync(storePath, JSON.stringify({}), "utf8");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	resetPluginConfigStoreCache();
});

describe("pluginConfig.form", () => {
	it("returns the manifest defaults as base and an empty user layer", async () => {
		const view = await service().configForm({ namespace: "plugin:demo" });

		expect(view.namespace).toBe("plugin:demo");
		expect(view.snapshot.status).toBe("ready");
		expect(view.snapshot.base).toEqual({ retries: 3, label: "auto" });
		// Nothing user-set yet: presence, not a copy of the defaults.
		expect(view.snapshot.user).toEqual({});
	});

	it("requires a namespace", async () => {
		await expect(service().configForm({})).rejects.toThrow(/namespace required/);
	});
});

describe("pluginConfig.mutate", () => {
	it("applies edits and advances the revision", async () => {
		const svc = service();
		const before = await svc.configForm({ namespace: "plugin:demo" });

		const result = await svc.configFormMutate({
			namespace: "plugin:demo",
			ops: [{ kind: "set", field: "retries", value: 8 }],
			expectedRevision: before.snapshot.revision,
		});

		expect(result.applied).toBe(true);
		expect(result.revision).toBe((before.snapshot.revision ?? 0) + 1);
	});

	it("refuses a stale revision so a form can say the edit lost", async () => {
		const svc = service();
		const before = await svc.configForm({ namespace: "plugin:demo" });
		// Someone else writes first.
		await svc.configFormMutate({
			namespace: "plugin:demo",
			ops: [{ kind: "set", field: "retries", value: 5 }],
		});

		const stale = await svc.configFormMutate({
			namespace: "plugin:demo",
			ops: [{ kind: "set", field: "retries", value: 99 }],
			expectedRevision: before.snapshot.revision,
		});

		// Refused, and the newer value survives.
		expect(stale.applied).toBe(false);
		const after = await svc.configForm({ namespace: "plugin:demo" });
		expect(after.snapshot.value?.retries).toBe(5);
	});

	it("clears a field back to the declared default on unset", async () => {
		const svc = service();
		await svc.configFormMutate({
			namespace: "plugin:demo",
			ops: [{ kind: "set", field: "retries", value: 8 }],
		});

		await svc.configFormMutate({
			namespace: "plugin:demo",
			ops: [{ kind: "unset", field: "retries" }],
		});

		const after = await svc.configForm({ namespace: "plugin:demo" });
		expect(after.snapshot.user).toEqual({});
		expect(after.snapshot.value?.retries).toBe(3);
	});

	it("requires a namespace", async () => {
		await expect(service().configFormMutate({ ops: [] })).rejects.toThrow(/namespace required/);
	});
});
