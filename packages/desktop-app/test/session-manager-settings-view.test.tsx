import "./happy-dom-shim";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { getLocaleSnapshot, setLocale, t } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingsView } from "../src/components/SettingsView";

/**
 * The 会话 section is host-owned until a `settings.tab.sessions` component is
 * actually loadable: the built-in page (and its retention controls) must stay
 * reachable, and a broken contribution must not blank the section.
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

function rpcWith(components: unknown[]): {
	request(method: string): Promise<unknown>;
	addEventListener(): () => void;
} {
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
	};
}

async function mountSessions(components: unknown[]): Promise<HTMLElement> {
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
				initialSection="sessions"
			/>,
		),
	);
	await act(async () => Bun.sleep(80));
	return container;
}

const PLUGIN_PAGE_CODE = [
	"export default function Page() {",
	'  return window.MusePiReact.createElement("div", null, "SESSION_MANAGER_PLUGIN");',
	"}",
].join("\n");

describe("SettingsView sessions section", () => {
	it("keeps the built-in retention page when no settings.tab.sessions exists", async () => {
		const container = await mountSessions([]);
		expect(container.textContent).toContain(t("general.sessionRetention"));
		expect(container.textContent).toContain(t("general.sessionDefaults"));
		expect(container.textContent).not.toContain(t("settings.sessionManager.title"));
	});

	it("renders the plugin page for the sessions section when the tab compiles", async () => {
		const container = await mountSessions([
			{
				slot: "settings.tab.sessions",
				extensionId: "/plugins/session-manager/index.ts",
				label: "会话",
				code: PLUGIN_PAGE_CODE,
				availability: "always",
			},
		]);
		expect(container.textContent).toContain("SESSION_MANAGER_PLUGIN");
		expect(container.textContent).not.toContain(t("general.sessionRetention"));
	});

	it("falls back to the built-in page when the contributed tab failed to compile", async () => {
		const container = await mountSessions([
			{
				slot: "settings.tab.sessions",
				extensionId: "/plugins/session-manager/index.ts",
				label: "会话",
				code: "",
				error: "compile failed",
			},
		]);
		expect(container.textContent).toContain(t("general.sessionRetention"));
		expect(container.textContent).not.toContain(t("settings.sessionManager.title"));
	});
});
