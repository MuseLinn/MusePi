import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StocksCard, stocksDefaults } from "../src/widgets/stocks";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
	void GlobalRegistrator.unregister();
});

const roots: Root[] = [];

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) act(() => root.unmount());
	}
	document.body.innerHTML = "";
});

describe("StocksCard", () => {
	test("shows a visible error when quote scripts are blocked without an unhandled rejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const host = document.createElement("div");
			document.body.appendChild(host);
			const root = createRoot(host);
			roots.push(root);
			const rows = (stocksDefaults().rows as Array<Record<string, string>>).slice(0, 1);
			act(() => root.render(<StocksCard data={{ rows }} update={() => {}} />));
			await act(async () => Bun.sleep(20));

			expect(document.body.textContent).toContain("真实 A 股行情暂时不可用");
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
