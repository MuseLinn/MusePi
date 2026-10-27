import "./happy-dom-shim";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FxCard, fxDefaults } from "../../client-core/src/widgets/fx";
import { HistoryCard, historyDefaults } from "../../client-core/src/widgets/history";
import { MusicCard, musicDefaults } from "../../client-core/src/widgets/music";
import { StocksCard, stocksDefaults } from "../../client-core/src/widgets/stocks";

const roots = new Set<Root>();
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots) await act(async () => root.unmount());
	roots.clear();
	document.body.innerHTML = "";
});

function mount(element: React.ReactNode): HTMLElement {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.add(root);
	act(() => root.render(element));
	return host;
}

describe("static collection previews", () => {
	it("shows FX example rows without starting requests or timers", () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const intervalSpy = vi.spyOn(globalThis, "setInterval");
		const host = mount(<FxCard data={fxDefaults()} preview update={() => {}} />);
		expect(host.textContent).toContain("EUR / CNY");
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(intervalSpy).not.toHaveBeenCalled();
	});

	it("shows stock examples without injecting JSONP scripts", () => {
		const host = mount(<StocksCard data={stocksDefaults()} preview update={() => {}} />);
		expect(host.textContent).toContain("贵州茅台");
		expect(document.head.querySelectorAll("script")).toHaveLength(0);
	});

	it("keeps the music preview free of animation-frame work", () => {
		const rafSpy = vi.spyOn(window, "requestAnimationFrame");
		const host = mount(<MusicCard data={musicDefaults()} preview update={() => {}} />);
		expect(host.textContent).toContain("播放队列");
		expect(rafSpy).not.toHaveBeenCalled();
	});

	it("shows history examples without fetching a data source", () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const host = mount(<HistoryCard data={historyDefaults()} preview update={() => {}} />);
		expect(host.textContent).toContain("2008");
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
