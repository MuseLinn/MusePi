/**
 * 会话内 HTML 卡片的标注入口。
 *
 * 卡片把 overlay 脚本 postMessage 进沙箱(不透明源,宿主读不到 frame 的
 * document),所以"卡片用哪套 chrome"只体现在那条消息里。这里接住脚本、在
 * happy-dom 里真跑一遍:元素/区域/笔迹的阅读方式必须与内置浏览器一致 ——
 * 结构化元素卡,而不是只带评论框的旧输入条。
 */
import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { t } from "../src/i18n/index.js";
import { HtmlCard } from "../src/widgets/html";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
	void GlobalRegistrator.unregister();
});

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

const FACE_HTML = '<div id="hero" class="hero">Hello world</div>';

interface Mounted {
	container: HTMLElement;
	root: Root;
}

async function mountCard(): Promise<Mounted> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			createElement(HtmlCard, {
				data: { html: FACE_HTML, data: {} },
				update: () => {},
				annotateCapture: async () => null,
			}),
		);
	});
	return { container, root };
}

/** Click the card's annotate button and return the overlay script it posted. */
async function startAnnotation(container: HTMLElement): Promise<string> {
	const frame = container.querySelector<HTMLIFrameElement>("iframe.gui-widget-html");
	if (!frame?.contentWindow) throw new Error("card frame missing");
	const post = vi.spyOn(frame.contentWindow, "postMessage");
	const button = container.querySelector<HTMLButtonElement>(".gui-widget-annotate-btn");
	expect(button).not.toBeNull();
	await act(async () => button!.click());

	const message = post.mock.calls
		.map(([value]) => value as { type?: string; script?: unknown } | null)
		.find(entry => entry?.type === "musepi-widget-annotate");
	expect(message).toBeDefined();
	expect(typeof message?.script).toBe("string");
	return message!.script as string;
}

interface OverlayRun {
	promise: Promise<unknown>;
	shadow: ShadowRoot;
	target: HTMLElement;
}

/** Run the posted script against a fixture page and expose its shadow root. */
function runOverlay(script: string): OverlayRun {
	document.body.innerHTML = FACE_HTML;
	const target = document.querySelector<HTMLElement>("#hero");
	if (!target) throw new Error("fixture target missing");

	// closed shadow 在本测试里换成 open,才能断言用户实际看到什么;host 仍
	// 挂在真实元素上,overlay 对自身的识别逻辑不受影响。
	const attach = Element.prototype.attachShadow;
	let captured: ShadowRoot | null = null;
	vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init: ShadowRootInit) {
		const root = attach.call(this, { ...init, mode: "open" });
		captured = root;
		return root;
	});
	vi.spyOn(document, "elementFromPoint").mockReturnValue(target);
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(40, 40, 160, 60));

	const promise = new Function(`return ${script}`)() as Promise<unknown>;
	if (!captured) throw new Error("overlay did not create a shadow root");
	return { promise, shadow: captured, target };
}

const pointer = (type: string, x: number, y: number): PointerEvent =>
	new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });

describe("HTML 卡片标注", () => {
	it("元素标注渲染结构化卡片,不再退回紧凑输入条", async () => {
		const card = await mountCard();
		const script = await startAnnotation(card.container);
		await act(async () => card.root.unmount());
		card.container.remove();

		const run = runOverlay(script);
		run.target.dispatchEvent(pointer("pointerdown", 60, 60));
		run.target.dispatchEvent(pointer("pointerup", 60, 60));

		const panel = run.shadow.querySelector<HTMLElement>(".panel");
		expect(panel).not.toBeNull();
		expect(panel?.style.display).toBe("flex");
		expect(panel?.getAttribute("aria-label")).toBe(t("annotation.panelTitle"));
		// 旧紧凑输入条只有评论框和提交按钮;它在,就说明 panel 文案没传到。
		expect(run.shadow.querySelector(".editor")).toBeNull();
		expect(run.shadow.querySelector(".panel-tag")?.textContent).toBe("div#hero");
		for (const title of [t("annotation.panelGeometry"), t("annotation.panelSemantics")]) {
			expect(panel?.textContent).toContain(title);
		}
		expect(run.shadow.querySelector(".panel-add")?.textContent).toBe(t("annotation.panelAdd"));

		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(await run.promise).toBeNull();
	});
});
