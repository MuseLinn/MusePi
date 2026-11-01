import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { encodeBase64Url, formatCollabLink } from "@musepi/collab-proto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const dom = await import("@happy-dom/global-registrator");
dom.GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { HostManager } = await import("../src/components/shell/HostManager");
const { rememberHost } = await import("../src/lib/hosts");

const key = Uint8Array.from({ length: 32 }, (_, index) => index);
const token = Uint8Array.from({ length: 16 }, (_, index) => index + 32);
const firstLink = formatCollabLink("ws://127.0.0.1:7466", "room-room-1", key, token);
const secondLink = formatCollabLink("ws://127.0.0.1:7466", "room-room-2", key, token);

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
	localStorage.clear();
	container = document.createElement("div");
	document.body.appendChild(container);
});

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	root = null;
	container?.remove();
	container = null;
	document.body.innerHTML = "";
	localStorage.clear();
});

afterAll(() => {
	void dom.GlobalRegistrator.unregister();
});

async function renderManager(
	currentLink: string,
	onSwitchTo: (link: string) => void,
	onLeave: () => void,
): Promise<void> {
	root = createRoot(container!);
	await act(async () => {
		root?.render(<HostManager currentLink={currentLink} phase="live" onSwitchTo={onSwitchTo} onLeave={onLeave} />);
	});
	await act(async () => {
		container?.querySelector<HTMLButtonElement>(".sh-host-chip")?.click();
		await Promise.resolve();
	});
}

describe("HostManager", () => {
	it("switches saved hosts without rendering their credentials", async () => {
		await rememberHost(firstLink, "Phone", "Desk A");
		await rememberHost(secondLink, "Phone", "Desk B");
		const selected: string[] = [];
		await renderManager(
			firstLink,
			link => selected.push(link),
			() => {},
		);

		const rows = [...document.querySelectorAll<HTMLButtonElement>(".sh-switcher-main")];
		const target = rows.find(row => row.textContent?.includes("Desk B"));
		expect(target).toBeDefined();
		await act(async () => target?.click());
		expect(selected).toEqual([secondLink]);
		expect(document.body.textContent).not.toContain(encodeBase64Url(key));
		expect(document.body.textContent).not.toContain(encodeBase64Url(token));
	});

	it("removing the active host leaves its session", async () => {
		await rememberHost(firstLink, "Phone", "Desk A");
		let leaves = 0;
		await renderManager(
			firstLink,
			() => {},
			() => leaves++,
		);

		const remove = document.querySelector<HTMLButtonElement>(
			'button[title="删除电脑"], button[title="Remove computer"]',
		);
		expect(remove).not.toBeNull();
		await act(async () => {
			remove?.click();
			await Promise.resolve();
		});
		expect(leaves).toBe(1);
		expect(localStorage.getItem("musepi.hosts.v1")).toBe("[]");
	});
});
