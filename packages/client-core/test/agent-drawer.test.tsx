import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { AgentSnapshot } from "@musepi/pi-wire";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SessionClient } from "../src/lib/client";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const { AgentDrawer } = await import("../src/components/agents/AgentDrawer");

afterAll(() => {
	void GlobalRegistrator.unregister();
});

const AGENT: AgentSnapshot = {
	id: "agent-1",
	displayName: "Worker",
	kind: "sub",
	status: "idle",
	hasSessionFile: false,
	createdAt: 1,
	lastActivity: 1,
};

function fakeClient(): SessionClient {
	return {
		getSnapshot: () => ({ progress: new Map() }),
		subscribe: () => () => {},
	} as unknown as SessionClient;
}

const roots: Root[] = [];

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) act(() => root.unmount());
	}
	document.body.innerHTML = "";
});

describe("AgentDrawer", () => {
	test("only the top drawer claims Escape", () => {
		const opener = document.createElement("button");
		document.body.appendChild(opener);
		opener.focus();
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		roots.push(root);
		const closed: string[] = [];
		act(() =>
			root.render(
				<>
					<AgentDrawer agent={AGENT} client={fakeClient()} readOnly onClose={() => closed.push("bottom")} />
					<AgentDrawer agent={AGENT} client={fakeClient()} readOnly onClose={() => closed.push("top")} />
				</>,
			),
		);

		act(() => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		});

		expect(closed).toEqual(["top"]);
	});
});
