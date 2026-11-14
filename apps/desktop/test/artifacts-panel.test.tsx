import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { setLocale, t } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ArtifactsPanel } from "../src/components/ArtifactsPanel";
import type { RpcClient } from "../src/lib/rpc";

const roots: Array<{ root: Root; host: HTMLElement }> = [];

afterEach(async () => {
	for (const { root, host } of roots.splice(0)) {
		await act(async () => root.unmount());
		host.remove();
	}
});

const ARTIFACTS = [
	{ dir: "home", dirName: "home", title: "Home", entry: "index.html", kind: "page", renderer: "html" },
	{ dir: "card", dirName: "card", title: "Card", entry: "index.html", kind: "component", renderer: "html" },
	{ dir: "about", dirName: "about", title: "About", entry: "index.html", kind: "page", renderer: "html" },
];

function makeRpc(): RpcClient {
	return {
		request: async (method: string) => {
			if (method === "artifact.list") return { rootPath: "/w", truncated: false, artifacts: ARTIFACTS };
			return {};
		},
	} as unknown as RpcClient;
}

async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

async function renderPanel(): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push({ root, host });
	await act(async () => {
		root.render(<ArtifactsPanel rpc={makeRpc()} cwd="/w" />);
	});
	await flush();
	return host;
}

describe("ArtifactsPanel design outputs", () => {
	it("offers a kind filter and narrows the gallery", async () => {
		setLocale("en-US");
		const host = await renderPanel();

		const chips = () => [...host.querySelectorAll<HTMLButtonElement>(".gui-art-filter")];
		expect(chips().map(chip => chip.textContent)).toEqual([t("tools.all"), "page2", "component1"]);

		expect(host.querySelectorAll(".gui-art-card")).toHaveLength(3);
		const componentChip = chips()[2]!;
		await act(async () => {
			componentChip.click();
		});
		await flush();

		const cards = [...host.querySelectorAll(".gui-art-card")];
		expect(cards).toHaveLength(1);
		expect(cards[0]?.textContent).toContain("Card");
		expect(componentChip.getAttribute("aria-selected")).toBe("true");
	});

	it("keeps a single-kind scan free of filter chrome", async () => {
		setLocale("en-US");
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		roots.push({ root, host });
		const single = {
			request: async () => ({
				rootPath: "/w",
				truncated: false,
				artifacts: [ARTIFACTS[0]],
			}),
		} as unknown as RpcClient;
		await act(async () => {
			root.render(<ArtifactsPanel rpc={single} cwd="/w" />);
		});
		await flush();
		expect(host.querySelector(".gui-art-filters")).toBeNull();
	});
});
