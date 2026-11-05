import "./happy-dom-shim";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingsView } from "../src/components/SettingsView";
import { INTEGRATIONS_SETTINGS_SECTION } from "../src/plugins/integrations/nav";

/**
 * The session info card's 「管理集成」 button asks the host for the
 * `integrations` section; SettingsView must resolve that name to the
 * plugin-contributed settings page.
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

function rpcWith(components: unknown[]) {
	return {
		request: async (method: string) => {
			switch (method) {
				case "extensions.list":
					return {
						extensions: [],
						tabs: [],
						providers: [],
						components,
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
	} as never;
}

const INTEGRATIONS_PAGE_CODE = [
	"export default function Page() {",
	'  return window.MusePiReact.createElement("div", null, "INTEGRATIONS_PLUGIN_PAGE");',
	"}",
].join("\n");

const INTEGRATIONS_TAB = [
	{
		slot: "settings.tab.integrations",
		extensionId: "/plugins/integrations/index.ts",
		label: "集成",
		code: INTEGRATIONS_PAGE_CODE,
		availability: "always",
	},
];

async function mount(initialSection?: "integrations"): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	roots.add(root);
	await act(async () =>
		root.render(
			<SettingsView
				rpc={rpcWith(INTEGRATIONS_TAB)}
				sessionId={null}
				providerEvent={null}
				onBack={() => {}}
				initialSection={initialSection}
			/>,
		),
	);
	await act(async () => Bun.sleep(80));
	return container;
}

describe("integrations settings section", () => {
	it("resolves initialSection=integrations to the plugin page", async () => {
		const container = await mount("integrations");
		expect(container.textContent).toContain("INTEGRATIONS_PLUGIN_PAGE");
	});

	it("keeps the default section when nothing requested integrations", async () => {
		const container = await mount();
		expect(container.textContent).not.toContain("INTEGRATIONS_PLUGIN_PAGE");
	});

	it("uses the same nav id the plugin slot produces", () => {
		expect(INTEGRATIONS_SETTINGS_SECTION).toBe("ext:settings.tab.integrations");
	});
});
