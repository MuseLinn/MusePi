import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TurnFileChange } from "../src/components/transcript/turn-files";
import { TURN_FILES_VISIBLE, TurnFilesCard } from "../src/components/transcript/turn-files-card";
import type { TurnSources } from "../src/components/transcript/turn-sources";
import { type TurnSourceCapabilities, TurnSourcesCard } from "../src/components/transcript/turn-sources-card";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(async () => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) await act(async () => root.unmount());
	}
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

afterAll(() => {
	void GlobalRegistrator.unregister();
});

async function mount(node: ReactNode): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () => root.render(node));
	return host;
}

const SOURCES: TurnSources = {
	pages: [
		{ url: "https://a.test/docs", title: "Docs", opens: 2, read: true },
		{ url: "https://b.test/read", title: "Read me", opens: 1, read: true },
		{ url: "https://c.test/passed", title: "", opens: 1, read: false },
	],
	readCount: 2,
	passedCount: 1,
};

const capabilities = (): TurnSourceCapabilities & Record<string, ReturnType<typeof vi.fn>> => {
	const openInPanel = vi.fn();
	const openExternal = vi.fn();
	const copyLink = vi.fn();
	return { openInPanel, openExternal, copyLink } as never;
};

describe("TurnSourcesCard", () => {
	it("starts collapsed and toggles on the header", async () => {
		const host = await mount(<TurnSourcesCard sources={SOURCES} capabilities={capabilities()} />);
		const head = host.querySelector<HTMLButtonElement>(".tr-sources-head");
		const body = host.querySelector(".tr-sources-body");
		expect(head?.getAttribute("aria-expanded")).toBe("false");
		expect(body?.className).toContain("tr-sources-body--closed");

		await act(async () => head?.click());
		expect(head?.getAttribute("aria-expanded")).toBe("true");
		expect(body?.className).not.toContain("tr-sources-body--closed");
	});

	it("groups read and passed pages and counts the opens in the header", async () => {
		const host = await mount(<TurnSourcesCard sources={SOURCES} capabilities={capabilities()} />);
		const groups = host.querySelectorAll(".tr-sources-group");
		expect(groups.length).toBe(2);
		expect(groups[0]?.querySelectorAll(".tr-sources-row").length).toBe(2);
		expect(groups[1]?.querySelectorAll(".tr-sources-row").length).toBe(1);
		// 2 read + 1 passed — both counts reach the header.
		expect(host.querySelector(".tr-sources-headline")?.textContent).toContain("2");
		expect(host.querySelector(".tr-sources-headline")?.textContent).toContain("1");
		// Only the page opened twice shows the visits meta.
		expect(host.querySelector(".tr-sources-visits")?.textContent).toContain("2");
	});

	it("disables every action when the host has no capability", async () => {
		const host = await mount(<TurnSourcesCard sources={SOURCES} capabilities={{}} />);
		const buttons = host.querySelectorAll<HTMLButtonElement>(".tr-sources-act");
		expect(buttons.length).toBe(9);
		for (const button of buttons) expect(button.disabled).toBe(true);
	});

	it("wires available actions to their capability with the page URL", async () => {
		const caps = capabilities();
		const host = await mount(<TurnSourcesCard sources={SOURCES} capabilities={caps} />);
		const row = host.querySelector(".tr-sources-row");
		const buttons = row?.querySelectorAll<HTMLButtonElement>(".tr-sources-act") ?? [];
		expect(buttons.length).toBe(3);
		for (const button of buttons) expect(button.disabled).toBe(false);

		await act(async () => buttons[0]?.click());
		expect(caps.openInPanel).toHaveBeenCalledWith("https://a.test/docs");
		await act(async () => buttons[1]?.click());
		expect(caps.openExternal).toHaveBeenCalledWith("https://a.test/docs");
		await act(async () => buttons[2]?.click());
		expect(caps.copyLink).toHaveBeenCalledWith("https://a.test/docs");
		// The copied row reports it instead of leaving the reader guessing.
		expect(buttons[2]?.getAttribute("aria-label")).toBeTruthy();
	});

	it("renders nothing for a turn that browsed nothing", async () => {
		const host = await mount(
			<TurnSourcesCard sources={{ pages: [], readCount: 0, passedCount: 0 }} capabilities={capabilities()} />,
		);
		expect(host.innerHTML).toBe("");
	});
});

describe("TurnFilesCard", () => {
	const file = (path: string, overrides: Partial<TurnFileChange> = {}): TurnFileChange => ({
		path,
		added: 1,
		removed: 0,
		hasDiff: true,
		...overrides,
	});

	const many = (count: number): TurnFileChange[] =>
		Array.from({ length: count }, (_, index) => file(`src/file-${index}.ts`));

	it("caps the list and expands the rest from the more button", async () => {
		const host = await mount(<TurnFilesCard files={many(TURN_FILES_VISIBLE + 2)} onOpenFile={vi.fn()} />);
		expect(host.querySelectorAll(".tr-turn-file").length).toBe(TURN_FILES_VISIBLE);
		const more = host.querySelector<HTMLButtonElement>(".tr-turn-files-more");
		expect(more?.textContent).toContain("2");

		await act(async () => more?.click());
		expect(host.querySelectorAll(".tr-turn-file").length).toBe(TURN_FILES_VISIBLE + 2);
		expect(host.querySelectorAll(".tr-turn-files-more").length).toBe(1);

		await act(async () => host.querySelector<HTMLButtonElement>(".tr-turn-files-more")?.click());
		expect(host.querySelectorAll(".tr-turn-file").length).toBe(TURN_FILES_VISIBLE);
	});

	it("shows the header count and the turn's line totals", async () => {
		const host = await mount(
			<TurnFilesCard
				files={[file("a.ts", { added: 4, removed: 2 }), file("b.ts", { added: 1 })]}
				onOpenFile={vi.fn()}
			/>,
		);
		const head = host.querySelector(".tr-turn-files-head");
		expect(head?.textContent).toContain("2");
		expect(head?.textContent).toContain("+5");
		expect(head?.textContent).toContain("−2");
	});

	it("says a file's changes cannot be itemized when it carries no diff", async () => {
		const host = await mount(
			<TurnFilesCard files={[file("notes.md", { added: 0, removed: 0, hasDiff: false })]} onOpenFile={vi.fn()} />,
		);
		expect(host.querySelector(".tr-turn-file-nodiff")?.textContent).toBeTruthy();
		expect(host.querySelector(".tr-turn-file-stats")).toBeNull();
	});

	it("opens the file through the supplied handler, or through the panel event by default", async () => {
		const onOpenFile = vi.fn();
		const host = await mount(<TurnFilesCard files={[file("src/a.ts")]} onOpenFile={onOpenFile} />);
		await act(async () => host.querySelector<HTMLButtonElement>(".tr-turn-file-open")?.click());
		expect(onOpenFile).toHaveBeenCalledWith("src/a.ts");

		const bare = await mount(<TurnFilesCard files={[file("src/a.ts")]} />);
		const opened: string[] = [];
		const listener = (event: Event): void => {
			opened.push((event as CustomEvent<{ path: string }>).detail.path);
		};
		window.addEventListener("musepi-open-file", listener);
		await act(async () => bare.querySelector<HTMLButtonElement>(".tr-turn-file-open")?.click());
		window.removeEventListener("musepi-open-file", listener);
		expect(opened).toEqual(["src/a.ts"]);
	});

	it("renders the loading line while the turn's changes are still being collected", async () => {
		const host = await mount(<TurnFilesCard files={[]} pending onOpenFile={vi.fn()} />);
		expect(host.querySelector("[role=status]")?.textContent).toBeTruthy();
	});

	it("renders nothing when the turn changed no file", async () => {
		const host = await mount(<TurnFilesCard files={[]} onOpenFile={vi.fn()} />);
		expect(host.innerHTML).toBe("");
	});
});
