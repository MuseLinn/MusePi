import "./happy-dom-shim";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { getLocaleSnapshot, setLocale, t } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { navGroups } from "../src/components/SettingsNav";
import { SettingsView } from "../src/components/SettingsView";
import { apply as applyUiTheme } from "../src/plugins/ui-theme";

/**
 * `settings.item.<page>.<row>` is a row the NAMED page renders after its own
 * content (SettingsView's `sectionItems`) — never a settings page of its own.
 * Pages ride the single `settings.section` list with an owner-supplied id.
 */

const roots = new Set<Root>();
const previousLocale = getLocaleSnapshot();

setLocale("zh-CN");

afterAll(() => setLocale(previousLocale));

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots.clear();
	document.body.innerHTML = "";
});

/** The component the ui-theme plugin registers, as the loader would hand it over. */
function uiThemeSeats(): { slot: string; label: string }[] {
	const seats: { slot: string; label: string }[] = [];
	applyUiTheme({
		setLabel: () => undefined,
		slots: { register: component => seats.push({ slot: component.slot, label: component.label }) },
	});
	return seats;
}

/** Minimal stand-in for the 外观 page module the settings-appearance package
 *  compiles to; the loader only needs a non-empty module to mount. */
const APPEARANCE_PAGE_CODE = [
	"export default function Page() {",
	'  return window.MusePiReact.createElement("div", { className: "appearance-page-stub" }, "APPEARANCE_PAGE");',
	"}",
].join("\n");

const SCROLL_TRACK_CARD = [
	"export default function Card() {",
	'  return window.MusePiReact.createElement("div", null, "SCROLL_TRACK_CARD");',
	"}",
].join("\n");

function rpcWith(components: unknown[]): {
	request(method: string): Promise<unknown>;
	addEventListener(): () => void;
} {
	return {
		request: async (method: string) => {
			switch (method) {
				case "extensions.list":
					return {
						// 外观页的内容现在由 settings-appearance 插件提供：把该包注册的
						// 页面交给 loader,与真实装配同一条路径。
						extensions: [],
						tabs: [],
						providers: [],
						// 外观页的内容现在由 settings-appearance 插件提供；loader 要的是
						// 编译后的 ESM,这里给出与该包入口相同的注册形态。
						components: [
							{
								slot: "settings.section",
								id: "appearance",
								label: t("settings.appearance"),
								code: APPEARANCE_PAGE_CODE,
								availability: "always",
							},
							...components,
						],
						toolViews: [],
						widgets: [],
						statusBarSegments: [],
						slots: { exact: [], prefixes: [] },
					};
				case "providers.list":
					return { oauth: [], api: [] };
				case "models.listCustom":
					return { providers: {} };
				case "session.list":
					return [];
				default:
					return {};
			}
		},
		addEventListener: () => () => {},
	};
}

async function mountAppearance(components: unknown[]): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	roots.add(root);
	await act(async () =>
		root.render(
			<SettingsView
				rpc={rpcWith(components) as never}
				sessionId={null}
				providerEvent={null}
				onBack={() => {}}
				initialSection="appearance"
			/>,
		),
	);
	await act(async () => Bun.sleep(120));
	return container;
}

/** Nav rows only — `.gui-settings-nav` is also the class of the settings-row hits. */
function navRowLabels(container: HTMLElement): string[] {
	return [...container.querySelectorAll(".gui-settings-nav:not(.gui-settings-nav--setting)")].map(
		row => row.textContent ?? "",
	);
}

describe("page-owned settings row seats", () => {
	it("the ui-theme row seat never becomes a nav page", () => {
		const extTabs = uiThemeSeats().filter(seat => seat.slot.startsWith("settings.item."));
		expect(extTabs.map(seat => seat.slot)).toEqual(["settings.item.appearance.rail"]);

		const items = navGroups(extTabs).flatMap(group => group.items);
		expect(items.some(item => String(item.id).startsWith("ext:"))).toBe(false);
		// A row seat never becomes a page of its own, and no row carries its label.
		// 外观 is plugin-owned now, so its single row needs the page contribution —
		// the row seat alone must still produce no page (and no `ext:` row).
		expect(items.filter(item => item.id === "appearance")).toHaveLength(0);
		expect(items.some(item => item.label === "滚动条皮肤")).toBe(false);
	});

	it("renders the seat inside 外观 while the nav stays free of it", async () => {
		const container = await mountAppearance([
			{
				slot: "settings.item.appearance.rail",
				extensionId: "/plugins/ui-theme/settings.tsx",
				label: "滚动条皮肤",
				code: SCROLL_TRACK_CARD,
				availability: "always",
			},
		]);

		// The row is on the page it names …
		expect(container.textContent).toContain("SCROLL_TRACK_CARD");
		// … and the nav lists 外观 once, with no second page borrowing the label.
		const labels = navRowLabels(container);
		expect(labels.filter(label => label === t("settings.appearance"))).toHaveLength(1);
		expect(labels).not.toContain("滚动条皮肤");
	});
});
