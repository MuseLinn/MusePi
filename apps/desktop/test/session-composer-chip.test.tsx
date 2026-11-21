import "./happy-dom-shim";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { SessionComposer } from "../src/components/SessionComposer";
import type { RpcClient } from "../src/lib/rpc";

/**
 * The model/thinking chip left the active chat's input row — the capsule
 * opens the agent info tab instead. A side session has no capsule (its tab
 * address is the session itself, and `session.agent` only addresses the
 * active chat), so its composer keeps the chip. `keepModelChip` defaults on
 * for exactly that reason; the active chat turns it off explicitly.
 */

const rpc = {
	request: async (method: string) => {
		if (method === "models.list") return [{ id: "m1", name: "Model One", provider: "prov" }];
		if (method === "session.contextUsage") return null;
		if (method === "settings.get") return {};
		return {};
	},
	addEventListener: () => () => {},
} as unknown as RpcClient;

async function mount(keepModelChip?: boolean) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<SessionComposer
				working={false}
				onSend={() => {}}
				onStop={() => {}}
				rpc={rpc}
				sessionId="session-1"
				quotes={[]}
				onQuotesChange={() => {}}
				thinkingLevel="medium"
				onSetThinking={() => {}}
				keepModelChip={keepModelChip}
			/>,
		);
	});
	return {
		host,
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

beforeEach(() => {
	setLocale("zh-CN");
	localStorage.setItem("musepi-gui-avatars", "0");
});

afterEach(() => {
	localStorage.clear();
	document.body.innerHTML = "";
});

afterAll(() => {
	setLocale("en-US");
});

describe("session composer model chip", () => {
	it("keeps the model/thinking chip by default (a side session has no capsule)", async () => {
		const { host, unmount } = await mount();
		expect(host.querySelector(".gui-model-capsule")).not.toBeNull();
		await unmount();
	});

	it("drops the chip when the host owns it elsewhere (the active chat)", async () => {
		const { host, unmount } = await mount(false);
		expect(host.querySelector(".gui-model-capsule")).toBeNull();
		expect(host.querySelector(".gui-composer-send")).not.toBeNull();
		expect(host.querySelectorAll(".gui-composer-ico").length).toBeGreaterThan(0);
		await unmount();
	});
});
