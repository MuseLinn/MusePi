/**
 * 标注 payload 契约与 prompt 格式化。
 *
 * payload 跨越信任边界(它产自运行在我们不控制的页面里的脚本),契约测试
 * 钉死的是"消费方会解引用的每个字段都校验":半合法输入必须在入口处被拒,
 * 而不是在 prompt 格式化或截图合成时才抛错。
 */
import { describe, expect, it } from "bun:test";
import {
	type AnnotationPayload,
	annotationTargetCount,
	isAnnotationElementTarget,
	isAnnotationPayload,
} from "../src/annotation/contract";
import { formatAnnotationPrompt } from "../src/annotation/prompt";

const elementTarget = {
	tag: "div",
	text: "Hello",
	selector: "#hero",
	path: "main > div#hero",
	bounds: { x: 0, y: 0, width: 100, height: 50 },
	center: { x: 50, y: 25 },
	attributes: { role: "banner" },
	computedStyle: { display: "block", position: "relative" },
	ancestry: [{ tag: "main", selectorPart: "main" }],
};

const validPayload: AnnotationPayload = {
	id: "annotation-1",
	pageUrl: "https://example.com/",
	pageTitle: "Example",
	viewport: { width: 1000, height: 700 },
	devicePixelRatio: 1,
	comment: "tighten this",
	elements: [{ id: "element-1", element: elementTarget }],
	regions: [{ id: "region-1", rect: { x: 10, y: 20, width: 30, height: 40 } }],
	strokes: [
		{
			id: "stroke-1",
			points: [
				{ x: 0, y: 0 },
				{ x: 5, y: 5 },
			],
			bounds: { x: 0, y: 0, width: 5, height: 5 },
		},
	],
};

describe("isAnnotationPayload", () => {
	it("接受完整 payload", () => {
		expect(isAnnotationPayload(validPayload)).toBe(true);
	});

	it("接受空标记数组", () => {
		expect(
			isAnnotationPayload({
				...validPayload,
				elements: [],
				regions: [],
				strokes: [],
			}),
		).toBe(true);
	});

	it("拒绝非数组 elements", () => {
		expect(isAnnotationPayload({ ...validPayload, elements: "nope" })).toBe(false);
	});

	it("拒绝元素缺 selector 的 payload", () => {
		const broken = {
			...validPayload,
			elements: [{ id: "element-1", element: { ...elementTarget, selector: undefined } }],
		};
		expect(isAnnotationPayload(broken)).toBe(false);
	});

	it("拒绝 bounds 缺字段的 region", () => {
		const broken = {
			...validPayload,
			regions: [{ id: "region-1", rect: { x: 10, y: 20, width: 30 } }],
		};
		expect(isAnnotationPayload(broken)).toBe(false);
	});

	it("拒绝 viewport 非有限数的 payload", () => {
		expect(isAnnotationPayload({ ...validPayload, viewport: { width: Number.NaN, height: 700 } })).toBe(false);
	});

	it("拒绝 null 与非对象", () => {
		expect(isAnnotationPayload(null)).toBe(false);
		expect(isAnnotationPayload("annotation-1")).toBe(false);
	});
});

describe("isAnnotationElementTarget", () => {
	it("ancestry 项缺 selectorPart 时拒绝", () => {
		expect(isAnnotationElementTarget({ ...elementTarget, ancestry: [{ tag: "main" }] })).toBe(false);
	});

	it("attributes 混入非字符串值时拒绝", () => {
		expect(isAnnotationElementTarget({ ...elementTarget, attributes: { role: 42 } })).toBe(false);
	});
});

describe("annotationTargetCount", () => {
	it("统计三类标记的总数", () => {
		expect(annotationTargetCount(validPayload)).toBe(3);
		expect(annotationTargetCount({ ...validPayload, elements: [], regions: [], strokes: [] })).toBe(0);
	});
});

describe("formatAnnotationPrompt", () => {
	it("正文恒英文:intro 之外的行不随界面语言变化", () => {
		const text = formatAnnotationPrompt({
			payload: validPayload,
			screenshotAttached: true,
			intro: "这是来自应用内浏览器的标注选区",
		});
		expect(text).toContain("这是来自应用内浏览器的标注选区:");
		expect(text).toContain("Page: Example");
		expect(text).toContain("URL: https://example.com/");
		expect(text).toContain("Screenshot: attached");
		expect(text).toContain("Comment: tighten this");
		expect(text).toContain("Element 1: div");
		expect(text).toContain("Selector: #hero");
		expect(text).toContain("Region 1: x=10, y=20, width=30, height=40");
		expect(text).toContain("Drawing 1: 2 points");
	});

	it("无标题页回退到 URL,有截图标记如实声明", () => {
		const text = formatAnnotationPrompt({
			payload: { ...validPayload, pageTitle: "  ", pageUrl: "https://example.com/" },
			screenshotAttached: false,
			intro: "intro",
		});
		expect(text).toContain("Page: https://example.com/");
		expect(text).toContain("Screenshot: not attached");
	});

	it("空注释不产出 Comment 行", () => {
		const text = formatAnnotationPrompt({
			payload: { ...validPayload, comment: "   " },
			screenshotAttached: true,
			intro: "intro",
		});
		expect(text).not.toContain("Comment:");
	});
});
