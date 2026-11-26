/**
 * Settings control vocabulary: the row's control follows the setting's
 * semantics, not its storage type.
 *
 * Regression covered here: free-form arrays used to render as a
 * comma-separated input (splitting `bash.patterns` regexes and dropping
 * `prompt.sections` objects), and numeric settings with declared presets
 * rendered as a bare `type=number` field that accepted unsupported values.
 */
import "./happy-dom-shim"; // MUST be first: installs the DOM globals.
import { afterEach, describe, expect, it } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SETTINGS_SCHEMA } from "../../../packages/coding-agent/src/config/settings-schema";
import {
	isSettingChanged,
	isSettingShown,
	type SchemaItem,
	SchemaSettings,
	settingsControl,
} from "../src/components/SchemaSettings";

function item(key: string, overrides: Partial<SchemaItem> = {}): SchemaItem {
	const def = SETTINGS_SCHEMA[key as keyof typeof SETTINGS_SCHEMA] as unknown as {
		type: SchemaItem["type"];
		default?: unknown;
		ui?: SchemaItem["ui"];
	};
	return { key, type: def.type, default: def.default, ui: def.ui, ...overrides };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
	if (root) act(() => root?.unmount());
	root = null;
	host?.remove();
	host = null;
	setLocale("en-US");
});

function mount(
	items: SchemaItem[],
	values: Record<string, unknown>,
	changes: [string, unknown][] = [],
): HTMLDivElement {
	setLocale("en-US");
	const element = document.createElement("div");
	document.body.appendChild(element);
	root = createRoot(element);
	act(() => {
		root?.render(
			createElement(SchemaSettings, {
				items,
				values,
				onChange: (key: string, value: unknown) => changes.push([key, value]),
			}),
		);
	});
	host = element;
	return element;
}

/** Stateful wrapper so a control can be exercised through several commits
 *  (the ladder only knows where it is from the value prop). */
function StatefulProbe({
	schemaItem,
	initial,
	changes,
}: {
	schemaItem: SchemaItem;
	initial: unknown;
	changes: [string, unknown][];
}): ReturnType<typeof SchemaSettings> {
	const [values, setValues] = useState<Record<string, unknown>>({ [schemaItem.key]: initial });
	return createElement(SchemaSettings, {
		items: [schemaItem],
		values,
		onChange: (key: string, value: unknown) => {
			changes.push([key, value]);
			setValues(previous => ({ ...previous, [key]: value }));
		},
	});
}

function keydown(element: Element, key: string, init: KeyboardEventInit = {}): void {
	act(() => {
		element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
	});
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
	// React tracks controlled values internally; driving the props directly is
	// the pattern the other DOM suites use (native "input" events are ignored
	// by this harness).
	const key = Object.keys(element).find(name => name.startsWith("__reactProps$"));
	const props = key ? (element as unknown as Record<string, { onChange?: (event: unknown) => void }>)[key] : undefined;
	if (!props?.onChange) throw new Error("no React onChange handler");
	act(() => {
		element.value = value;
		props.onChange?.({ target: element, currentTarget: element });
	});
}

function blur(element: Element): void {
	const key = Object.keys(element).find(name => name.startsWith("__reactProps$"));
	const props = key ? (element as unknown as Record<string, { onBlur?: (event: unknown) => void }>)[key] : undefined;
	act(() => props?.onBlur?.({ target: element, currentTarget: element }));
}

describe("settingsControl", () => {
	it("maps declared numeric presets to the ladder, free numbers to the counter", () => {
		expect(settingsControl(item("temperature"))).toBe("ladder");
		expect(settingsControl(item("tools.artifactSpillThreshold"))).toBe("ladder");
		expect(settingsControl(item("images.urls.sshRemotePort"))).toBe("number");
		expect(settingsControl(item("retry.maxDelayMs"))).toBe("number");
	});

	it("maps free-form arrays by element shape instead of storage type", () => {
		// Strings: tools, rules, shell minimizer lists.
		expect(settingsControl(item("tools.xdevInlineDevices"))).toBe("list");
		expect(settingsControl(item("workspace.additionalDirectories"))).toBe("list");
		expect(settingsControl(item("ttsr.disabledRules"))).toBe("list");
		// Records: a comma-separated editor would destroy each element.
		expect(settingsControl(item("bash.patterns"))).toBe("json-list");
		expect(settingsControl(item("prompt.sections"))).toBe("json-list");
		// Declared membership keeps the chip/priority editors.
		expect(settingsControl(item("images.urls.backends"))).toBe("ordered");
		expect(settingsControl(item("compaction.methodOrder"))).toBe("ordered");
		expect(settingsControl(item("goal.continuationModes"))).toBe("chips");
	});

	it("maps the remaining primitives", () => {
		expect(settingsControl(item("memory.backend"))).toBe("select");
		expect(settingsControl(item("advisor.enabled"))).toBe("toggle");
		expect(settingsControl(item("providers.maxInFlightRequests"))).toBe("record");
	});
});

describe("numeric controls", () => {
	it("renders a detent ladder for a preset numeric setting", () => {
		const scope = mount([item("temperature")], { temperature: 0.7 });
		expect(scope.querySelector(".gui-slider--detent")).not.toBeNull();
		expect(scope.querySelector('input[type="number"]')).toBeNull();
		// One tick per declared preset, and the active preset's label is shown.
		const presets = (SETTINGS_SCHEMA.temperature.ui.options ?? []).length;
		expect(scope.querySelectorAll(".gui-slider-dot").length).toBe(presets);
		expect(scope.querySelector(".gui-slider-value")?.textContent).toBe("0.7");
	});

	it("moves one preset per arrow key instead of accepting arbitrary numbers", () => {
		const changes: [string, unknown][] = [];
		const scope = mount([item("temperature")], { temperature: 0.5 }, changes);
		const track = scope.querySelector(".gui-slider-track");
		if (!track) throw new Error("no ladder track");
		keydown(track, "ArrowRight");
		expect(changes.at(-1)).toEqual(["temperature", 0.7]);
		keydown(track, "End");
		expect(changes.at(-1)).toEqual(["temperature", 1]);
	});

	it("puts the thumb under the cursor on the press frame, not on a detent", () => {
		const changes: [string, unknown][] = [];
		const scope = mount([item("temperature")], { temperature: 0.5 }, changes);
		const track = scope.querySelector<HTMLElement>(".gui-slider-track");
		if (!track) throw new Error("no ladder track");
		const rect = (left: number, width: number): DOMRect =>
			({
				left,
				top: 0,
				right: left + width,
				bottom: 22,
				width,
				height: 22,
				x: left,
				y: 0,
				toJSON: () => ({}),
			}) as DOMRect;
		track.getBoundingClientRect = () => rect(0, 300);
		const rail = track.querySelector<HTMLElement>(".gui-slider-rail");
		if (!rail) throw new Error("no rail");
		rail.getBoundingClientRect = () => rect(0, 300);
		const thumb = (): number => Number(track.style.getPropertyValue("--gui-slider-p")) * 300;
		const presets = (SETTINGS_SCHEMA.temperature.ui.options ?? []).length - 1;
		if (presets < 2) return;

		// 6 presets over 300px: detents at 0, 60, 120… A press at 90 is midway,
		// and the thumb must render there rather than jumping to detent 2 (120).
		act(() => track.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 90 })));
		expect(thumb()).toBeCloseTo(90, 6);
		// The committed value still decides what a release lands on, not the thumb.
		expect(changes).toEqual([]);
		act(() => track.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, cancelable: true, clientX: 93 })));
		expect(thumb()).toBeCloseTo(93, 6);
		// A press with no travel commits the detent under the pointer, once.
		expect(changes).toEqual([]);
		act(() => track.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true, clientX: 93 })));
		expect(changes).toEqual([["temperature", 0.2]]);
	});

	it("writes nothing when a settings drag is cancelled", () => {
		const changes: [string, unknown][] = [];
		const scope = mount([item("temperature")], { temperature: 0.5 }, changes);
		const track = scope.querySelector<HTMLElement>(".gui-slider-track");
		if (!track) throw new Error("no ladder track");
		const rect = (left: number, width: number): DOMRect =>
			({
				left,
				top: 0,
				right: left + width,
				bottom: 22,
				width,
				height: 22,
				x: left,
				y: 0,
				toJSON: () => ({}),
			}) as DOMRect;
		track.getBoundingClientRect = () => rect(0, 300);
		const rail = track.querySelector<HTMLElement>(".gui-slider-rail");
		if (!rail) throw new Error("no rail");
		rail.getBoundingClientRect = () => rect(0, 300);
		const thumb = (): number => Number(track.style.getPropertyValue("--gui-slider-p")) * 300;
		const resting = thumb();

		act(() => track.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 30 })));
		act(() => track.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, cancelable: true, clientX: 240 })));
		act(() =>
			track.dispatchEvent(new MouseEvent("pointercancel", { bubbles: true, cancelable: true, clientX: 240 })),
		);
		// A cancelled gesture neither writes nor leaves the thumb where it was dragged.
		expect(changes).toEqual([]);
		expect(thumb()).toBeCloseTo(resting, 6);
	});

	it("drags continuously and writes once, on release", () => {
		const changes: [string, unknown][] = [];
		const scope = mount([item("temperature")], { temperature: 0.5 }, changes);
		const track = scope.querySelector<HTMLElement>(".gui-slider-track");
		if (!track) throw new Error("no ladder track");
		// Happy-dom lays nothing out; give the measured rail a 300px span.
		const rect = (left: number, width: number): DOMRect =>
			({
				left,
				top: 0,
				right: left + width,
				bottom: 22,
				width,
				height: 22,
				x: left,
				y: 0,
				toJSON: () => ({}),
			}) as DOMRect;
		track.getBoundingClientRect = () => rect(0, 300);
		const rail = track.querySelector<HTMLElement>(".gui-slider-rail");
		if (!rail) throw new Error("no rail");
		rail.getBoundingClientRect = () => rect(0, 300);
		const thumb = (): number => Number(track.style.getPropertyValue("--gui-slider-p")) * 300;
		const presets = (SETTINGS_SCHEMA.temperature.ui.options ?? []).length - 1;

		act(() => track.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 0 })));
		const steps: number[] = [];
		let previous = thumb();
		for (let x = 10; x <= 60; x += 10) {
			act(() => track.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, cancelable: true, clientX: x })));
			steps.push(thumb() - previous);
			previous = thumb();
		}
		// The settings ladder is the thinking ladder's implementation: 10px of
		// pointer travel is 10px of thumb travel, not a hop between presets.
		if (presets > 1) for (const step of steps) expect(step).toBeCloseTo(10, 6);
		expect(changes).toEqual([]);
	});

	it("snaps to the nearest detent without writing every pointer tick", () => {
		const changes: [string, unknown][] = [];
		const scope = mount([item("temperature")], { temperature: 0.5 }, changes);
		const track = scope.querySelector<HTMLElement>(".gui-slider-track");
		if (!track) throw new Error("no ladder track");
		const rect = (left: number, width: number): DOMRect =>
			({
				left,
				top: 0,
				right: left + width,
				bottom: 22,
				width,
				height: 22,
				x: left,
				y: 0,
				toJSON: () => ({}),
			}) as DOMRect;
		track.getBoundingClientRect = () => rect(0, 300);
		const rail = track.querySelector<HTMLElement>(".gui-slider-rail");
		if (!rail) throw new Error("no rail");
		rail.getBoundingClientRect = () => rect(0, 300);

		act(() => track.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 0 })));
		for (let x = 10; x <= 300; x += 10) {
			act(() => track.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, cancelable: true, clientX: x })));
		}
		// Dragging across the whole ladder wrote nothing yet.
		expect(changes).toEqual([]);
		act(() => track.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true, clientX: 300 })));
		// One write for the whole gesture, on the last preset.
		expect(changes).toEqual([["temperature", 1]]);
	});

	it("steps a free number and keeps the step proportional to its magnitude", () => {
		const port: [string, unknown][] = [];
		const portScope = mount([item("images.urls.sshRemotePort")], { "images.urls.sshRemotePort": 8787 }, port);
		const dial = portScope.querySelector(".gui-rollnum");
		if (!dial) throw new Error("no rolling counter");
		keydown(dial, "ArrowUp");
		expect(port.at(-1)).toEqual(["images.urls.sshRemotePort", 8788]);
		keydown(dial, "ArrowUp", { shiftKey: true });
		expect(port.at(-1)).toEqual(["images.urls.sshRemotePort", 8798]);

		const timeout: [string, unknown][] = [];
		const timeoutScope = mount([item("retry.maxDelayMs")], { "retry.maxDelayMs": 300000 }, timeout);
		const bigDial = timeoutScope.querySelector(".gui-rollnum");
		if (!bigDial) throw new Error("no rolling counter");
		keydown(bigDial, "ArrowUp");
		// 300000 → six digits → step 100 instead of one.
		expect(timeout.at(-1)).toEqual(["retry.maxDelayMs", 300100]);
	});

	it("honours declared step bounds (fractional settings)", () => {
		const changes: [string, unknown][] = [];
		const scope = mount([item("tts.rate")], { "tts.rate": 1 }, changes);
		const dial = scope.querySelector(".gui-rollnum");
		if (!dial) throw new Error("no rolling counter");
		keydown(dial, "ArrowUp");
		expect(changes.at(-1)).toEqual(["tts.rate", 1.05]);
		keydown(dial, "End");
		expect(changes.at(-1)).toEqual(["tts.rate", 2]);
	});

	it("keeps the named default preset reachable after leaving it", () => {
		// The schema spells the default stop as "default" while the stored
		// value is the numeric sentinel -1. Dropping it from the ladder left
		// the default reachable only while it was already the current value.
		const changes: [string, unknown][] = [];
		const scope = document.createElement("div");
		document.body.appendChild(scope);
		root = createRoot(scope);
		act(() =>
			root?.render(
				createElement(StatefulProbe, {
					schemaItem: item("compaction.thresholdPercent"),
					initial: -1,
					changes,
				}),
			),
		);
		host = scope;
		const track = scope.querySelector(".gui-slider-track");
		if (!track) throw new Error("no ladder track");
		expect(scope.querySelectorAll(".gui-slider-dot").length).toBe(13);
		expect(scope.querySelector(".gui-slider-value")?.textContent).toBe("Default");

		keydown(track, "ArrowRight");
		expect(changes.at(-1)).toEqual(["compaction.thresholdPercent", 10]);
		expect(scope.querySelector(".gui-slider-value")?.textContent).toBe("10%");

		keydown(track, "Home");
		expect(changes.at(-1)).toEqual(["compaction.thresholdPercent", -1]);
		expect(scope.querySelector(".gui-slider-value")?.textContent).toBe("Default");
	});
});

describe("compaction dependency gates", () => {
	it("hides the percentage while a fixed token cap governs", () => {
		const row = item("compaction.thresholdPercent");
		expect(isSettingShown(row, {})).toBe(true);
		expect(isSettingShown(row, { "compaction.thresholdTokens": 100_000 })).toBe(false);
	});

	it("shows method-specific rows only while that method is in the order", () => {
		const remote = item("compaction.remoteStreamingV2Enabled");
		expect(isSettingShown(remote, { "compaction.methodOrder": ["remote", "soft"] })).toBe(true);
		expect(isSettingShown(remote, { "compaction.methodOrder": ["soft"] })).toBe(false);

		const handoff = item("compaction.handoffSaveToDisk");
		expect(isSettingShown(handoff, { "compaction.methodOrder": ["handoff"] })).toBe(true);
		expect(isSettingShown(handoff, { "compaction.methodOrder": ["soft"] })).toBe(false);
	});

	it("shows idle details only when idle compaction is on", () => {
		const threshold = item("compaction.idleThresholdTokens");
		expect(isSettingShown(threshold, {})).toBe(false);
		expect(isSettingShown(threshold, { "compaction.idleEnabled": true })).toBe(true);
	});

	it("hides the per-model editor when per-model limits are off", () => {
		const row = item("compaction.modelThresholds");
		expect(isSettingShown(row, { "compaction.modelThresholdsEnabled": true })).toBe(true);
		expect(isSettingShown(row, { "compaction.modelThresholdsEnabled": false })).toBe(false);
	});
});

describe("memory backend gates", () => {
	it("shows the MuseMem group only while MuseMem (or its former id) is selected", () => {
		const row = item("musemem.globalScope");
		expect(isSettingShown(row, { "memory.backend": "musemem" })).toBe(true);
		expect(isSettingShown(row, { "memory.backend": "local" })).toBe(true);
		expect(isSettingShown(row, { "memory.backend": "hindsight" })).toBe(false);
		expect(isSettingShown(row, {})).toBe(false);
	});

	it("evaluates a declarative condition carried by a plugin setting", () => {
		const row = item("musemem.globalScope", {
			ui: {
				tab: "memory",
				group: "MuseMem",
				label: "MuseMem Global Scope",
				condition: { key: "memory.backend", equals: "musemem" },
			},
		});
		expect(isSettingShown(row, { "memory.backend": "musemem" })).toBe(true);
		expect(isSettingShown(row, { "memory.backend": "hindsight" })).toBe(false);
	});

	it("keeps the Hindsight block off while another backend is selected", () => {
		const row = item("hindsight.globalScope");
		expect(isSettingShown(row, { "memory.backend": "hindsight" })).toBe(true);
		expect(isSettingShown(row, { "memory.backend": "musemem" })).toBe(false);
	});
});

describe("array editors", () => {
	it("keeps a value that contains commas intact", () => {
		const scope = mount([item("tools.xdevInlineDevices")], { "tools.xdevInlineDevices": ["a,b"] });
		const inputs = scope.querySelectorAll<HTMLInputElement>(".gui-list-input");
		expect(inputs.length).toBe(1);
		expect(inputs[0]?.value).toBe("a,b");
		expect(scope.querySelector('input[placeholder="Comma separated values"]')).toBeNull();
	});

	it("removes one row without touching the others", () => {
		const changes: [string, unknown][] = [];
		const scope = mount([item("ttsr.disabledRules")], { "ttsr.disabledRules": ["one", "two"] }, changes);
		const remove = scope.querySelectorAll<HTMLButtonElement>(".gui-list-remove");
		act(() => remove[0]?.click());
		expect(changes.at(-1)).toEqual(["ttsr.disabledRules", ["two"]]);
	});

	it("renders object arrays as JSON, not as split strings", () => {
		const value = [{ match: "rm -rf *", approval: "deny" }];
		const scope = mount([item("bash.patterns")], { "bash.patterns": value });
		const textarea = scope.querySelector<HTMLTextAreaElement>(".gui-list-json");
		if (!textarea) throw new Error("no JSON list");
		expect(scope.querySelector(".gui-list-input")).toBeNull();
		expect(JSON.parse(textarea.value)).toEqual(value);
	});

	it("rejects invalid JSON without committing", () => {
		const changes: [string, unknown][] = [];
		const scope = mount([item("bash.patterns")], { "bash.patterns": [] }, changes);
		const textarea = scope.querySelector<HTMLTextAreaElement>(".gui-list-json");
		if (!textarea) throw new Error("no JSON list");
		setValue(textarea, "[{ match: rm }]");
		blur(textarea);
		expect(changes).toEqual([]);
		expect(scope.querySelector(".gui-list-invalid")?.textContent).toBe("Expected a JSON array");
	});

	it("gives every array row its own full-width line", () => {
		const scope = mount([item("tools.xdevInlineDevices")], { "tools.xdevInlineDevices": [] });
		const row = scope.querySelector(".gui-settings-row");
		expect(row?.classList.contains("gui-settings-row--wide-control")).toBe(true);
	});
});

describe("priority editors", () => {
	it("uses a drag handle per row and removes one entry without the old arrows", () => {
		const changes: [string, unknown][] = [];
		const scope = mount(
			[item("compaction.methodOrder")],
			{ "compaction.methodOrder": ["remote", "snapcompact"] },
			changes,
		);
		const rows = scope.querySelectorAll(".gui-ordered-item");
		expect(rows.length).toBe(2);
		// Handle on every row; the only remaining row button is remove.
		expect(scope.querySelectorAll(".gui-ordered-grip").length).toBe(2);
		expect(scope.querySelectorAll(".gui-ordered-btn").length).toBe(2);
		expect(scope.textContent?.includes("↑")).toBe(false);
		expect(rows[0]?.querySelector(".gui-ordered-rank")?.textContent).toBe("1");
		act(() => rows[0]?.querySelector<HTMLButtonElement>(".gui-ordered-btn--remove")?.click());
		expect(changes.at(-1)).toEqual(["compaction.methodOrder", ["snapcompact"]]);
	});
});

describe("reset to default", () => {
	it("shows the reset affordance only when the value differs from its default", () => {
		const scope = mount([item("temperature")], { temperature: 0.7 });
		expect(scope.querySelector(".gui-settings-row-reset")).not.toBeNull();
	});

	it("hides the reset affordance on an untouched row", () => {
		const scope = mount([item("temperature")], { temperature: -1 });
		expect(scope.querySelector(".gui-settings-row-reset")).toBeNull();
	});

	it("writes the schema default back and tags the row for the search jump", () => {
		const changes: [string, unknown][] = [];
		const scope = mount([item("temperature")], { temperature: 0.7 }, changes);
		expect(scope.querySelector('[data-setting-key="temperature"]')).not.toBeNull();
		act(() => scope.querySelector<HTMLButtonElement>(".gui-settings-row-reset")?.click());
		expect(changes.at(-1)).toEqual(["temperature", -1]);
	});

	it("resets an array to a copy of its default", () => {
		const changes: [string, unknown][] = [];
		const scope = mount([item("tools.xdevInlineDevices")], { "tools.xdevInlineDevices": ["a"] }, changes);
		act(() => scope.querySelector<HTMLButtonElement>(".gui-settings-row-reset")?.click());
		expect(changes.at(-1)).toEqual(["tools.xdevInlineDevices", []]);
	});

	it("resets a record to a copy of its default", () => {
		const changes: [string, unknown][] = [];
		const scope = mount(
			[item("providers.maxInFlightRequests")],
			{ "providers.maxInFlightRequests": { fake: 2 } },
			changes,
		);
		act(() => scope.querySelector<HTMLButtonElement>(".gui-settings-row-reset")?.click());
		expect(changes.at(-1)).toEqual(["providers.maxInFlightRequests", {}]);
	});

	it("never offers reset for credentials (the daemon does not echo them back)", () => {
		const scope = mount(
			[{ key: "demo.apiKey", type: "string", default: "", ui: { label: "API Key", description: "" } }],
			{},
		);
		expect(scope.querySelector(".gui-settings-row-reset")).toBeNull();
	});

	it("compares containers by content", () => {
		expect(isSettingChanged({ default: -1 }, -1)).toBe(false);
		expect(isSettingChanged({ default: -1 }, 10)).toBe(true);
		expect(isSettingChanged({ default: [] }, [])).toBe(false);
		expect(isSettingChanged({ default: [] }, ["a"])).toBe(true);
		expect(isSettingChanged({ default: { a: 1 } }, { a: 1 })).toBe(false);
		expect(isSettingChanged({ default: { a: 1 } }, { a: 2 })).toBe(true);
		expect(isSettingChanged({ default: undefined }, "x")).toBe(false);
	});
});

describe("plugin config lists", () => {
	it("edits a list field row by row instead of joining on commas", async () => {
		const { ConfigFormRenderer } = await import("../src/components/ConfigFormRenderer");
		const changes: [string, unknown][] = [];
		const element = document.createElement("div");
		document.body.appendChild(element);
		root = createRoot(element);
		act(() =>
			root?.render(
				createElement(ConfigFormRenderer, {
					fields: [{ key: "ignored", type: "list" as const, default: [] }],
					values: { ignored: ["a,b"] },
					onChange: (key: string, value: unknown) => changes.push([key, value]),
				}),
			),
		);
		const inputs = element.querySelectorAll<HTMLInputElement>(".gui-list-input");
		expect(inputs.length).toBe(1);
		expect(inputs[0]?.value).toBe("a,b");
		expect(element.querySelector('input[aria-label="ignored"]')).toBeNull();
		act(() => element.querySelector<HTMLButtonElement>(".gui-list-remove")?.click());
		expect(changes.at(-1)).toEqual(["ignored", []]);
	});
});

describe("context page directories", () => {
	it("renders the directory editor and drops the schema comma row", async () => {
		const { ContextSection } = await import("../src/components/settings-sections/context");
		const rpc = {
			request: async (method: string) => {
				if (method === "settings.schema") {
					return {
						context: [
							{
								key: "workspace.additionalDirectories",
								type: "array",
								default: [],
								ui: {
									tab: "context",
									group: "General",
									label: "Additional Workspace Dirs",
									description: "Extra workspace directories.",
								},
							},
						],
					};
				}
				if (method === "settings.get") return { "workspace.additionalDirectories": ["/tmp/one"] };
				return {};
			},
		};
		const element = document.createElement("div");
		document.body.appendChild(element);
		root = createRoot(element);
		await act(async () => {
			root?.render(createElement(ContextSection, { rpc: rpc as never }));
			await Bun.sleep(10);
		});
		expect(element.querySelector(".gui-settings-directories")).not.toBeNull();
		expect(element.querySelector(".gui-directory-row-path")?.textContent).toBe("/tmp/one");
		// The schema row for the same key must not render a second editor.
		expect(element.textContent).not.toContain("Additional Workspace Dirs");
	});
});
