/**
 * 标注附件契约:payload 的 includeScreenshot 是唯一的开关。
 *
 * 关掉时,调用方即使已经拍好截图也不能把它塞进附件,正文也必须说
 * "not attached" —— 图和 prompt 互相矛盾会让智能体按不存在的画面推理。
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	ANNOTATION_ATTACH_EVENT,
	type AnnotationAttachDetail,
	dispatchAnnotationResult,
} from "../src/annotation/attach";
import type { AnnotationPayload } from "../src/annotation/contract";

GlobalRegistrator.register();

afterAll(() => {
	void GlobalRegistrator.unregister();
});

const payload: AnnotationPayload = {
	id: "annotation-1",
	pageUrl: "https://example.com/",
	pageTitle: "Example",
	viewport: { width: 1000, height: 700 },
	devicePixelRatio: 1,
	comment: "tighten this",
	elements: [],
	regions: [],
	strokes: [],
};

const details: AnnotationAttachDetail[] = [];
const onAttach = (event: Event): void => {
	details.push((event as CustomEvent<AnnotationAttachDetail>).detail);
};

window.addEventListener(ANNOTATION_ATTACH_EVENT, onAttach);

afterEach(() => {
	details.length = 0;
});

const screenshot = (): File => new File(["png-bytes"], "annotation.png", { type: "image/png" });

describe("dispatchAnnotationResult screenshot switch", () => {
	it("includeScreenshot=false 时不附图,正文声明 not attached", async () => {
		await dispatchAnnotationResult({
			payload: { ...payload, includeScreenshot: false },
			screenshot: screenshot(),
			intro: "Browser annotation",
		});

		expect(details).toHaveLength(1);
		const detail = details[0];
		expect(detail?.image).toBeUndefined();
		expect(detail?.displayContext.image).toBeUndefined();
		expect(detail?.text).toContain("Screenshot: not attached");
	});

	it("缺省与显式 true 都附图", async () => {
		await dispatchAnnotationResult({ payload, screenshot: screenshot(), intro: "Browser annotation" });
		await dispatchAnnotationResult({
			payload: { ...payload, includeScreenshot: true },
			screenshot: screenshot(),
			intro: "Browser annotation",
		});

		expect(details).toHaveLength(2);
		for (const detail of details) {
			expect(detail.image).toBeInstanceOf(File);
			expect(detail.displayContext.image).toStartWith("data:image/png;base64,");
			expect(detail.text).toContain("Screenshot: attached");
		}
	});

	it("开关打开但截图缺失时不伪造附件", async () => {
		await dispatchAnnotationResult({ payload, screenshot: null, intro: "Browser annotation" });
		expect(details[0]?.image).toBeUndefined();
		expect(details[0]?.text).toContain("Screenshot: not attached");
	});
});
