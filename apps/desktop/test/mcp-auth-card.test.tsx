import "./happy-dom-shim"; // MUST be first: component module graphs define HTMLElement subclasses at evaluation time.
import { afterAll, describe, expect, it } from "bun:test";
import { setLocale } from "@musepi/client-core";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { McpAuthCard, type McpAuthRequest } from "../src/components/McpAuthCard";

setLocale("zh-CN");
afterAll(() => {
	setLocale("en-US");
});

const REQUEST: McpAuthRequest = {
	requestId: "req-1",
	serverName: "github",
	flowId: "flow-1",
	authorizationUrl: "https://provider.example/authorize?state=s1",
};

function mount(node: ReactNode): {
	container: HTMLElement;
	render(next: ReactNode): void;
} {
	const container = document.createElement("div");
	const root = createRoot(container);
	act(() => root.render(node));
	return {
		container,
		render(next) {
			act(() => root.render(next));
		},
	};
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
	const found = [...container.querySelectorAll("button")].find(candidate => candidate.textContent?.includes(label));
	if (!(found instanceof HTMLButtonElement)) throw new Error(`no button labelled ${label}`);
	return found;
}

function click(target: HTMLButtonElement): void {
	act(() => target.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("McpAuthCard", () => {
	it("opens the browser once, then offers a reopen instead of repeating the first prompt", () => {
		const opened: string[] = [];
		const { container } = mount(
			<McpAuthCard
				request={REQUEST}
				onAuthorize={r => opened.push(r.flowId)}
				onCancel={() => {}}
				onDismiss={() => {}}
			/>,
		);

		expect(container.textContent).toContain("需要浏览器授权");
		click(button(container, "在浏览器中授权"));
		expect(opened).toEqual(["flow-1"]);
		expect(container.textContent).toContain("已在浏览器打开授权页");
		expect(container.textContent).toContain("等待浏览器完成授权");

		click(button(container, "重新打开"));
		expect(opened).toEqual(["flow-1", "flow-1"]);
	});

	it("cancels the parked grant when the user backs out", () => {
		const cancelled: string[] = [];
		const { container } = mount(
			<McpAuthCard
				request={REQUEST}
				onAuthorize={() => {}}
				onCancel={r => cancelled.push(r.requestId)}
				onDismiss={() => {}}
			/>,
		);

		click(button(container, "取消"));
		expect(cancelled).toEqual(["req-1"]);
	});

	it("shows the landed grant without actions, so the confirmation cannot be re-fired", () => {
		const { container } = mount(
			<McpAuthCard
				request={REQUEST}
				state="success"
				onAuthorize={() => {}}
				onCancel={() => {}}
				onDismiss={() => {}}
			/>,
		);

		expect(container.textContent).toContain("已授权");
		expect(container.querySelectorAll("button").length).toBe(0);
	});

	it("keeps the provider's failure reason and lets the user dismiss it", () => {
		const dismissed: string[] = [];
		const { container } = mount(
			<McpAuthCard
				request={REQUEST}
				state="error"
				error="token exchange rejected"
				onAuthorize={() => {}}
				onCancel={() => {}}
				onDismiss={r => dismissed.push(r.requestId)}
			/>,
		);

		expect(container.textContent).toContain("token exchange rejected");
		click(button(container, "关闭"));
		expect(dismissed).toEqual(["req-1"]);
	});

	it("returns to the first prompt when a new request replaces the old one", () => {
		const { container, render } = mount(
			<McpAuthCard request={REQUEST} onAuthorize={() => {}} onCancel={() => {}} onDismiss={() => {}} />,
		);
		click(button(container, "在浏览器中授权"));
		expect(container.textContent).toContain("已在浏览器打开授权页");

		render(
			<McpAuthCard
				request={{ ...REQUEST, requestId: "req-2" }}
				onAuthorize={() => {}}
				onCancel={() => {}}
				onDismiss={() => {}}
			/>,
		);
		expect(container.textContent).toContain("需要浏览器授权");
		expect(container.textContent).not.toContain("已在浏览器打开授权页");
	});
});
