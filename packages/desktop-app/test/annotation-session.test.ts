/**
 * 标注会话运行器:从注入 overlay 到把 payload 带回来的完整往返。
 *
 * 宿主是 mock 的 —— 这套逻辑必须在没有活的 `<webview>` 的环境下可测。
 * 被钉死的契约:页内取消不截图;半合法 payload 被丢弃并拆 overlay;捕获
 * 失败/为空时标注本身必须幸存(截图降级为 null,绝不丢标注)。
 */
import { describe, expect, test } from "bun:test";
import type { AnnotationOverlayLabels, AnnotationOverlayTheme } from "@musepi/client-core/src/annotation/overlay";
import {
	type AnnotationHost,
	cancelAnnotationSession,
	type PageCapture,
	runAnnotationSession,
} from "../src/lib/annotation-session";

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
	select: "元素",
	marquee: "区域",
	draw: "绘制",
	commentPlaceholder: "描述所需更改…",
	submit: "附加",
};

const validPayload = {
	id: "annotation-1",
	pageUrl: "http://localhost:5173/",
	pageTitle: "App",
	viewport: { width: 1000, height: 700 },
	devicePixelRatio: 1,
	comment: "收紧这里",
	elements: [
		{
			id: "element-1",
			element: {
				tag: "div",
				text: "Hi",
				selector: "#hero",
				path: "main > div#hero",
				bounds: { x: 0, y: 0, width: 100, height: 50 },
				center: { x: 50, y: 25 },
				attributes: {},
				computedStyle: {},
				ancestry: [],
			},
		},
	],
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

const capture: PageCapture = { mime: "image/png", base64: "AAAA", width: 1000, height: 700 };

type Call = { code: string; gesture?: boolean };

/** mock 宿主:overlay 脚本返回 overlayResult,viewport 探针返回固定视口。 */
const createHost = (options: {
	overlayResult: unknown;
	capturePage?: () => Promise<PageCapture | null>;
}): { host: AnnotationHost; calls: Call[] } => {
	const calls: Call[] = [];
	const host: AnnotationHost = {
		executeJavaScript: async (code: string, gesture?: boolean) => {
			calls.push({ code, gesture });
			if (code.includes("new Promise")) return options.overlayResult;
			if (code.includes("window.innerWidth")) return { width: 1000, height: 700 };
			return undefined;
		},
		capturePage: options.capturePage ?? (async () => capture),
	};
	return { host, calls };
};

describe("annotation session", () => {
	test("页内取消返回 null,且不触发页面截图", async () => {
		let captures = 0;
		const { host } = createHost({
			overlayResult: null,
			capturePage: async () => {
				captures += 1;
				return null;
			},
		});
		expect(await runAnnotationSession({ host, theme, labels })).toBeNull();
		expect(captures).toBe(0);
	});

	test("半合法 payload 被丢弃并拆除 overlay", async () => {
		const { host, calls } = createHost({ overlayResult: { id: "x", elements: "not-an-array" } });
		const result = await runAnnotationSession({ host, theme, labels });
		expect(result).toBeNull();
		expect(calls.some(call => call.code.includes("data-musepi-annotation"))).toBe(true);
	});

	test("合法 payload 全字段往返(截图在无 DOM 环境降级为 null)", async () => {
		const { host } = createHost({ overlayResult: validPayload });
		const result = await runAnnotationSession({ host, theme, labels });
		expect(result?.payload.id).toBe("annotation-1");
		expect(result?.payload.comment).toBe("收紧这里");
		expect(result?.payload.elements).toHaveLength(1);
		expect(result?.payload.regions).toHaveLength(1);
		expect(result?.payload.strokes).toHaveLength(1);
		expect(result?.screenshot).toBeNull();
	});

	test("捕获抛错时标注幸存,截图为 null", async () => {
		const { host } = createHost({
			overlayResult: validPayload,
			capturePage: async () => {
				throw new Error("capture failed");
			},
		});
		const result = await runAnnotationSession({ host, theme, labels });
		expect(result?.payload.id).toBe("annotation-1");
		expect(result?.screenshot).toBeNull();
	});

	test("捕获返回空时标注幸存,截图为 null", async () => {
		const { host } = createHost({ overlayResult: validPayload, capturePage: async () => null });
		const result = await runAnnotationSession({ host, theme, labels });
		expect(result?.payload.id).toBe("annotation-1");
		expect(result?.screenshot).toBeNull();
	});

	test("overlay 以用户手势执行,页面把它当成交互", async () => {
		const { host, calls } = createHost({ overlayResult: null });
		await runAnnotationSession({ host, theme, labels });
		expect(calls[0]?.gesture).toBe(true);
	});

	test("取消过期会话容忍页面已销毁", async () => {
		const host: AnnotationHost = {
			executeJavaScript: async () => {
				throw new Error("webview destroyed");
			},
			capturePage: async () => null,
		};
		// 契约是绝不抛错:页面销毁时取消也要安静结束。
		await expect(cancelAnnotationSession(host)).resolves.toBeUndefined();
	});
});
