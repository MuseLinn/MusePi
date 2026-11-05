import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";

interface Mounted {
	root: HTMLDivElement;
	markdown(): string;
	destroy(): Promise<void>;
}

async function mount(
	source: string,
	documentPath: string,
	readFileDataUrl: (path: string) => Promise<{ dataUrl?: string }>,
): Promise<Mounted> {
	const { Editor, rootCtx, defaultValueCtx } = await import("@milkdown/kit/core");
	const { commonmark } = await import("@milkdown/kit/preset/commonmark");
	const { getMarkdown } = await import("@milkdown/kit/utils");
	const { markdownHtmlView } = await import("../src/components/markdown-html");
	(window as unknown as { electronAPI?: unknown }).electronAPI = { readFileDataUrl };
	const root = document.createElement("div");
	document.body.appendChild(root);
	const editor = await Editor.make()
		.config(ctx => {
			ctx.set(rootCtx, root);
			ctx.set(defaultValueCtx, source);
		})
		.use(commonmark)
		.use(markdownHtmlView(documentPath))
		.create();
	return {
		root,
		markdown: () => editor.action(getMarkdown()),
		destroy: async () => {
			await editor.destroy();
			root.remove();
		},
	};
}

afterEach(() => {
	delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe("visual Markdown editor raw HTML", () => {
	it("renders README media and layout instead of printing the tags", async () => {
		const requested: string[] = [];
		const mounted = await mount(
			'<p align="center"><img src="banner.png" width="1280" alt="MusePi"></p>',
			"D:/repo/docs/README.md",
			async path => {
				requested.push(path);
				return { dataUrl: "data:image/png;base64,AAAA" };
			},
		);
		try {
			// The bridge answer lands in a microtask.
			await new Promise(resolve => setTimeout(resolve, 0));
			const image = mounted.root.querySelector<HTMLImageElement>('img[alt="MusePi"]');
			expect(image).not.toBeNull();
			expect(image?.getAttribute("width")).toBe("1280");
			expect(mounted.root.querySelector('p[align="center"]')).not.toBeNull();
			expect(requested).toEqual(["D:/repo/docs/banner.png"]);
			expect(image?.src).toBe("data:image/png;base64,AAAA");
			// The atom still serializes the original source verbatim.
			expect(mounted.markdown()).toContain('<img src="banner.png" width="1280" alt="MusePi">');
		} finally {
			await mounted.destroy();
		}
	});

	it("leaves unsafe markup out of the rendered document", async () => {
		const mounted = await mount(
			'<p>safe<script>alert(1)</script><img src="javascript:alert(1)" alt="bad"></p>',
			"/repo/README.md",
			async () => ({}),
		);
		try {
			expect(mounted.root.querySelector("script")).toBeNull();
			expect(mounted.root.querySelector('img[alt="bad"]')?.getAttribute("src")).toBeNull();
			expect(mounted.root.textContent).toContain("safe");
		} finally {
			await mounted.destroy();
		}
	});
});
