/**
 * The shared loader is what both the desktop slot host and the guest/mobile
 * board use to turn `extensions.list.widgets` into registry entries. Pin the
 * metadata mapping and the failure rule here so one host cannot silently
 * diverge from the other.
 */
import { describe, expect, it } from "bun:test";
import type { ExtensionWidgetArtifact } from "../src/widgets/extension-widgets";
import { loadExtensionWidgets } from "../src/widgets/extension-widgets";

const CARD = "export default function Card(){ return null; }";

function artifact(overrides: Partial<ExtensionWidgetArtifact> = {}): ExtensionWidgetArtifact {
	return {
		type: "probe",
		label: "Probe",
		description: "one line",
		fields: [{ key: "value", type: "number", label: "值" }],
		defaults: { value: 1 },
		tone: "dark",
		code: CARD,
		...overrides,
	};
}

describe("loadExtensionWidgets", () => {
	it("maps metadata and the default component into a widget def", async () => {
		const [def] = await loadExtensionWidgets([artifact()]);
		expect(def?.type).toBe("probe");
		expect(def?.label).toBe("Probe");
		expect(def?.description).toBe("one line");
		expect(def?.tone).toBe("dark");
		expect(typeof def?.Component).toBe("function");
		expect(def?.fields.map(field => field.key)).toEqual(["value"]);
	});

	it("copies defaults per call so boards never share one object", async () => {
		const [def] = await loadExtensionWidgets([artifact()]);
		const first = def?.defaults();
		const second = def?.defaults();
		expect(first).toEqual({ value: 1 });
		expect(first).not.toBe(second);
	});

	it("skips compile failures and modules without a component", async () => {
		const defs = await loadExtensionWidgets([
			artifact({ type: "broken", error: "compile failed", code: "" }),
			artifact({ type: "empty", code: "export const x = 1;" }),
			artifact({ type: "ok" }),
		]);
		expect(defs.map(def => def.type)).toEqual(["ok"]);
	});
});
