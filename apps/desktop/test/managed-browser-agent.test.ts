import "./happy-dom-shim";
import { afterEach, describe, expect, test } from "bun:test";
import { closeTab, createTab, getHostState, setBrowserSession, tabAgent } from "../src/lib/managed-browser-host";

const originalElectronAPI = window.electronAPI;

afterEach(() => {
	for (const tab of getHostState().tabs) closeTab(tab.id, { notifyMain: false });
	setBrowserSession(null);
	Object.defineProperty(window, "electronAPI", { configurable: true, writable: true, value: originalElectronAPI });
});

describe("managed browser agent attribution", () => {
	test("an agent-created tab names its operator and loses it on close", () => {
		void createTab("https://example.test", {
			tabId: "agent-tab",
			agent: true,
			agentId: "Helper",
			agentName: "Helper",
		}).catch(() => {});

		expect(tabAgent("agent-tab")).toEqual({ id: "Helper", name: "Helper" });
		expect(getHostState().tabs.find(tab => tab.id === "agent-tab")?.agentName).toBe("Helper");

		closeTab("agent-tab", { notifyMain: false });
		expect(tabAgent("agent-tab")).toBeNull();
	});

	test("falls back to the agent id when no display name was published", () => {
		void createTab("https://example.test", { tabId: "bare-agent", agent: true, agentId: "Scout" }).catch(() => {});

		expect(tabAgent("bare-agent")).toEqual({ id: "Scout", name: "Scout" });
	});

	test("user tabs and restored tabs have no operator", () => {
		void createTab("https://example.test", { tabId: "user-tab" }).catch(() => {});

		const tab = getHostState().tabs.find(candidate => candidate.id === "user-tab");
		expect(tab?.agentId).toBeNull();
		expect(tab?.agentName).toBeNull();
		expect(tabAgent("user-tab")).toBeNull();
		expect(tabAgent("missing-tab")).toBeNull();
	});
});
