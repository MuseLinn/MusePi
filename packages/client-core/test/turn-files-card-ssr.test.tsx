import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@musepi/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantBody } from "../src/components/transcript/transcript-content";
import type { TurnFileChange } from "../src/components/transcript/turn-files";
import { TurnFilesCard } from "../src/components/transcript/turn-files-card";
import type { TurnSources } from "../src/components/transcript/turn-sources";

/**
 * Hosts without a window (guest/export render) cannot dispatch the right-panel
 * preview event, so the open action renders disabled instead of pretending to
 * work. Kept out of the happy-dom suite: that file installs a window.
 */

function assistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		model: "test/model",
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } },
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("TurnFilesCard without a window", () => {
	it("disables the open action", () => {
		// happy-dom registers `window` for the whole test process, so a sibling
		// file would otherwise make this SSR-only branch unreachable.
		const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
		Reflect.deleteProperty(globalThis, "window");
		try {
			const html = renderToStaticMarkup(
				<TurnFilesCard files={[{ path: "src/a.ts", added: 1, removed: 0, hasDiff: true }]} />,
			);
			expect(html).toContain("tr-turn-file-open");
			expect(html).toContain('disabled=""');
		} finally {
			if (saved) Object.defineProperty(globalThis, "window", saved);
		}
	});
});

describe("AssistantBody turn surfaces", () => {
	const files: TurnFileChange[] = [
		{ path: "src/a.ts", added: 3, removed: 1, hasDiff: true },
		{ path: "docs/new.md", added: 0, removed: 0, hasDiff: false },
	];
	const sources: TurnSources = {
		pages: [{ url: "https://a.test", title: "A", opens: 2, read: true }],
		readCount: 1,
		passedCount: 0,
	};

	const body = (overrides: Partial<Parameters<typeof AssistantBody>[0]> = {}): string =>
		renderToStaticMarkup(
			<AssistantBody
				message={assistantMessage()}
				results={new Map()}
				active={new Map()}
				pending={false}
				turnFiles={files}
				sources={sources}
				{...overrides}
			/>,
		);

	it("renders both turn surfaces under the reply", () => {
		const html = body();
		expect(html).toContain("tr-turn-files");
		expect(html).toContain("tr-sources");
		expect(html).toContain("src/a.ts");
		expect(html).toContain("https://a.test");
	});

	it("keeps the artifact chips when the turn has no change list", () => {
		const html = body({ turnFiles: undefined, artifacts: [{ id: "t1", path: "docs/out.md" }] });
		expect(html).toContain("tr-file-cards");
		expect(html).not.toContain("tr-turn-files");
	});

	it("renders no surface for a turn that produced nothing", () => {
		const html = body({ turnFiles: undefined, sources: undefined });
		expect(html).not.toContain("tr-turn-files");
		expect(html).not.toContain("tr-sources");
	});
});
