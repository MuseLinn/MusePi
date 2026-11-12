import "./happy-dom-shim";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { getLocaleSnapshot, setLocale, t } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SessionInfoCard } from "../src/components/session-info-card";

/**
 * The connector section is the session-side entry point to MCP settings. It
 * must render even with zero servers — the former "only when servers exist"
 * gate left a new user with no visible way to add one — and its manage entry
 * must open the MCP section, not a generic settings open. With servers present
 * the entry rides the picker header so the card does not repeat itself with a
 * second "MCP servers" row.
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

function rpcStub(servers: Array<{ name: string; transport: "http"; status: "connected" }>) {
	return {
		request: async (method: string) => {
			switch (method) {
				case "connectors.list":
					return { servers, selected: null };
				case "session.contextUsage":
					return { model: "anthropic/claude" };
				case "extensions.list":
					return { extensions: [], components: [], tabs: [], providers: [], toolViews: [], widgets: [] };
				default:
					return {};
			}
		},
		addEventListener: () => () => {},
	} as never;
}

async function mount(
	servers: Array<{ name: string; transport: "http"; status: "connected" }>,
	onOpenSettings: (section?: string) => void,
) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	roots.add(root);
	await act(async () =>
		root.render(
			<SessionInfoCard sessionId="session-1" rpc={rpcStub(servers)} tabs={[]} onOpenSettings={onOpenSettings} />,
		),
	);
	await act(async () => Bun.sleep(40));
	return container;
}

describe("SessionInfoCard connectors", () => {
	it("keeps a manage entry when no connector is configured", async () => {
		const opened: Array<string | undefined> = [];
		const container = await mount([], section => opened.push(section));

		// The empty state names the section and its action; restating the MCP
		// description here duplicated the heading in other words.
		expect(container.textContent).toContain(t("tools.connectorsPanelTitle"));
		expect(container.textContent).toContain(t("settings.mcpServers"));
		expect(container.textContent).not.toContain(t("settings.mcpSettings"));
		const manage = container.querySelector<HTMLButtonElement>(".gui-session-info-manage-connectors");
		expect(manage).not.toBeNull();

		await act(async () => manage?.click());
		expect(opened).toEqual(["mcp"]);
	});

	it("lists configured servers and still offers the manage entry", async () => {
		const opened: Array<string | undefined> = [];
		const container = await mount([{ name: "linear", transport: "http", status: "connected" }], section =>
			opened.push(section),
		);

		expect(container.textContent).toContain("linear");
		expect(container.textContent).not.toContain(t("settings.mcpSettings"));
		expect(container.querySelector(".gui-session-info-manage-connectors")).toBeNull();
		const manage = [
			...container.querySelectorAll<HTMLButtonElement>(".gui-connector-panel-head .gui-connector-link"),
		].find(button => button.textContent === t("tools.connectorsManage"));
		expect(manage).not.toBeUndefined();

		await act(async () => manage?.click());
		expect(opened).toEqual(["mcp"]);
	});
});
