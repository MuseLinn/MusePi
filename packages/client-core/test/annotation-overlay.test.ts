/**
 * 注入 overlay 的行为测试:在 happy-dom 里真跑生成的脚本,点选元素、折叠分区、
 * 关掉截图开关再提交,断言最终 payload。
 *
 * shadow root 用一份 detached 的 open root 代替:chrome 的构建与数据来源都在
 * 脚本内部,这里验证的是用户能看到什么、提交出去什么,不是 closed 隔离本身。
 */
import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { AnnotationPayload } from "../src/annotation/contract";
import {
	type AnnotationOverlayLabels,
	type AnnotationOverlayTheme,
	buildAnnotationOverlayScript,
} from "../src/annotation/overlay";

GlobalRegistrator.register();

afterAll(() => {
	void GlobalRegistrator.unregister();
});

const theme: AnnotationOverlayTheme = {
	colorScheme: "dark",
	primary: "rgb(1, 2, 3)",
	primarySoft: "rgba(1, 2, 3, 0.16)",
	primaryFaint: "rgba(1, 2, 3, 0.1)",
	primaryContrast: "rgb(255, 255, 255)",
	surface: "rgb(10, 10, 10)",
	surfaceElevated: "rgb(20, 20, 20)",
	glassSurface: "rgba(20, 20, 20, 0.64)",
	glassFilter: "blur(26px) saturate(1.16)",
	border: "rgb(30, 30, 30)",
	text: "rgb(240, 240, 240)",
	mutedText: "rgb(160, 160, 160)",
};

const labels: AnnotationOverlayLabels = {
	select: "Element",
	marquee: "Region",
	draw: "Draw",
	commentPlaceholder: "Describe the change…",
	submit: "Attach",
	panel: {
		title: "Annotation details",
		close: "Close",
		sectionGeometry: "Position & geometry",
		sectionSemantics: "Semantics & state",
		sectionData: "data-* attributes",
		sectionPage: "Page & capture",
		selector: "Selector",
		path: "Path",
		bounds: "Position",
		size: "Size",
		center: "Center",
		text: "Text",
		styles: "Styles",
		page: "Page",
		url: "URL",
		viewport: "Viewport",
		dpr: "DPR",
		screenshot: "Include screenshot",
		cancel: "Cancel",
		add: "Add to input",
	},
};

type OverlayRun = {
	readonly promise: Promise<unknown>;
	readonly shadow: ShadowRoot;
	readonly target: HTMLElement;
};

const mountOverlay = ({
	labels: overlayLabels,
	html = '<div id="hero" class="hero card" role="banner" data-testid="hero" data-state="open">Hello world</div>',
}: {
	labels: AnnotationOverlayLabels;
	html?: string;
}): OverlayRun => {
	document.body.innerHTML = html;
	document.title = "Demo page";
	const target = document.querySelector<HTMLElement>("#hero");
	if (!target) throw new Error("fixture target missing");

	// 让 overlay 的 closed shadow 在测试里可读;代理仍挂在真实 host 上,
	// 因此 chrome 事件在 isOverlayNode 眼里仍是 overlay 自己。
	const attach = Element.prototype.attachShadow;
	let captured: ShadowRoot | null = null;
	vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init: ShadowRootInit) {
		const root = attach.call(this, { ...init, mode: "open" });
		captured = root;
		return root;
	});
	vi.spyOn(document, "elementFromPoint").mockReturnValue(target);
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(120, 80, 200, 60));

	const script = buildAnnotationOverlayScript(theme, overlayLabels);
	expect(buildAnnotationOverlayScript(theme, overlayLabels, { elementAt: { x: 12, y: 34 } })).toContain(
		'"elementAt":{"x":12,"y":34}',
	);
	const promise = new Function(`return ${script}`)() as Promise<unknown>;
	if (!captured) throw new Error("overlay did not create a shadow root");
	return { promise, shadow: captured, target };
};

const pointer = (type: string, x: number, y: number): PointerEvent =>
	new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });

const selectTarget = (run: OverlayRun): void => {
	run.target.dispatchEvent(pointer("pointerdown", 150, 100));
	run.target.dispatchEvent(pointer("pointerup", 150, 100));
};

const section = (shadow: ShadowRoot, title: string): HTMLElement | null => {
	for (const candidate of shadow.querySelectorAll<HTMLElement>(".panel-section")) {
		if (candidate.querySelector(".panel-section-head")?.textContent?.includes(title)) return candidate;
	}
	return null;
};

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

describe("annotation overlay panel", () => {
	it("元素标注显示完整结构信息,并能折叠分区", async () => {
		const run = mountOverlay({ labels });
		selectTarget(run);
		const { shadow } = run;

		const panel = shadow.querySelector<HTMLElement>(".panel");
		expect(panel?.style.display).toBe("flex");
		expect(panel?.getAttribute("role")).toBe("dialog");
		expect(panel?.getAttribute("aria-label")).toBe("Annotation details");

		expect(shadow.querySelector(".panel-tag")?.textContent).toBe("div#hero");
		expect(shadow.querySelector(".panel-classes")?.textContent).toBe(".hero.card");
		expect(shadow.querySelector(".panel-close")?.getAttribute("aria-label")).toBe("Close");

		const geometry = section(shadow, "Position & geometry");
		expect(geometry?.textContent).toContain("#hero");
		expect(geometry?.textContent).toContain("x 120, y 80, w 200, h 60");
		expect(geometry?.textContent).toContain("x 220, y 110");

		const semantics = section(shadow, "Semantics & state");
		expect(semantics?.textContent).toContain("Hello world");
		expect(semantics?.textContent).toContain("banner");

		const data = section(shadow, "data-* attributes");
		expect(data?.textContent).toContain("data-state");
		expect(data?.textContent).toContain("open");
		expect(data?.textContent).toContain("data-testid");

		const page = section(shadow, "Page & capture");
		expect(page?.textContent).toContain("Demo page");
		expect(page?.textContent).toContain("Viewport");
		expect(page?.textContent).toContain("DPR");

		const head = geometry?.querySelector<HTMLButtonElement>(".panel-section-head");
		const rows = geometry?.querySelector<HTMLElement>(".panel-rows");
		expect(head?.getAttribute("aria-expanded")).toBe("true");
		head?.click();
		expect(head?.getAttribute("aria-expanded")).toBe("false");
		expect(rows?.hidden).toBe(true);
		head?.click();
		expect(head?.getAttribute("aria-expanded")).toBe("true");
		expect(rows?.hidden).toBe(false);

		const toggle = shadow.querySelector<HTMLInputElement>(".panel-toggle input");
		expect(toggle?.checked).toBe(true);
		expect(shadow.querySelector(".panel-toggle")?.textContent).toContain("Include screenshot");
		toggle!.checked = false;
		toggle!.dispatchEvent(new Event("change"));

		const comment = shadow.querySelector<HTMLTextAreaElement>(".panel textarea");
		comment!.value = "Make it blue";
		comment!.dispatchEvent(new Event("input"));

		shadow.querySelector<HTMLElement>(".panel-add")?.click();
		const payload = (await run.promise) as AnnotationPayload;
		expect(payload.includeScreenshot).toBe(false);
		expect(payload.comment).toBe("Make it blue");
		expect(payload.elements).toHaveLength(1);
		expect(payload.elements[0]?.element.attributes["data-state"]).toBe("open");
	});

	it("区域标注只显示几何与评论,不伪装成元素", async () => {
		const run = mountOverlay({ labels });
		const { shadow } = run;
		shadow.querySelectorAll<HTMLButtonElement>(".tools button")[1]?.click();

		run.target.dispatchEvent(pointer("pointerdown", 300, 200));
		run.target.dispatchEvent(pointer("pointermove", 420, 280));
		run.target.dispatchEvent(pointer("pointerup", 420, 280));

		expect((shadow.querySelector<HTMLElement>(".panel-head") as HTMLElement).hidden).toBe(true);
		expect(shadow.querySelectorAll(".panel-section")).toHaveLength(1);
		const geometry = section(shadow, "Position & geometry");
		expect(geometry?.textContent).toContain("Region 1");
		expect(geometry?.textContent).toContain("x 300, y 200, w 120, h 80");
		expect(section(shadow, "Semantics & state")).toBeNull();
		expect(section(shadow, "data-* attributes")).toBeNull();
		expect(shadow.querySelector(".panel-tag")).toBeNull();

		shadow.querySelector<HTMLElement>(".panel-add")?.click();
		const payload = (await run.promise) as AnnotationPayload;
		expect(payload.regions).toHaveLength(1);
		expect(payload.elements).toHaveLength(0);
		expect(payload.includeScreenshot).toBe(true);
	});

	it("没有 panel 文案时退回旧输入条", async () => {
		const legacyLabels: AnnotationOverlayLabels = {
			select: "Element",
			marquee: "Region",
			draw: "Draw",
			commentPlaceholder: "Describe the change…",
			submit: "Attach",
		};
		const run = mountOverlay({ labels: legacyLabels });
		selectTarget(run);

		expect(run.shadow.querySelector(".panel")).toBeNull();
		const editor = run.shadow.querySelector<HTMLElement>(".editor");
		expect(editor?.style.display).toBe("flex");
		expect(run.shadow.querySelector(".editor textarea")).not.toBeNull();
		expect(run.shadow.querySelector(".editor button")?.getAttribute("aria-label")).toBe("Attach");
	});

	it("头部关闭只移除当前元素;评论框 Enter 仍能提交", async () => {
		const run = mountOverlay({ labels });
		const { shadow } = run;
		selectTarget(run);

		const panel = shadow.querySelector<HTMLElement>(".panel");
		shadow.querySelector<HTMLElement>(".panel-close")?.click();
		expect(panel?.style.display).toBe("none");

		selectTarget(run);
		const comment = shadow.querySelector<HTMLTextAreaElement>(".panel textarea");
		comment!.value = "Use the accent color";
		comment!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

		const payload = (await run.promise) as AnnotationPayload;
		expect(payload.comment).toBe("Use the accent color");
		expect(payload.elements).toHaveLength(1);
	});

	it("Escape 取消整次标注,不产出 payload", async () => {
		const run = mountOverlay({ labels });
		selectTarget(run);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(await run.promise).toBeNull();
	});
});
