/**
 * 驱动一次标注会话从头到尾跑完。
 *
 * overlay 会先拆掉自己的 chrome、等两次 repaint 才 resolve,所以随后做的
 * 截图里只有页面和你的标记,没有我们的 UI。页面本身从不被修改 —— 标注
 * 只标记已有内容,不编辑它。
 */

import { type AnnotationPayload, isAnnotationPayload } from "@musepi/client-core/src/annotation/contract";
import {
	ANNOTATION_TEARDOWN_SCRIPT,
	type AnnotationOverlayLabels,
	type AnnotationOverlayTheme,
	buildAnnotationOverlayScript,
} from "@musepi/client-core/src/annotation/overlay";
import { renderAnnotationScreenshot } from "@musepi/client-core/src/annotation/screenshot";

export type PageCapture = {
	readonly mime: string;
	readonly base64: string;
	readonly width: number;
	readonly height: number;
};

/**
 * 一次标注会话需要从宿主拿到的能力。按名字抽象,会话因此可以在没有活的
 * `<webview>` 的环境下被测试。
 */
export type AnnotationHost = {
	readonly executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
	readonly capturePage: () => Promise<PageCapture | null>;
};

export type AnnotationSessionResult = {
	readonly payload: AnnotationPayload;
	readonly screenshot: File | null;
};

const VIEWPORT_SCRIPT = "({ width: window.innerWidth, height: window.innerHeight })";

const readViewport = async (host: AnnotationHost): Promise<{ width: number; height: number } | null> => {
	try {
		const value = await host.executeJavaScript(VIEWPORT_SCRIPT, true);
		if (!value || typeof value !== "object") return null;
		const record = value as { width?: unknown; height?: unknown };
		if (typeof record.width !== "number" || typeof record.height !== "number") return null;
		if (!Number.isFinite(record.width) || !Number.isFinite(record.height)) return null;
		return { width: record.width, height: record.height };
	} catch {
		return null;
	}
};

/** 尽力清掉上一次会话遗留的 overlay。没有活动会话时调用也安全。 */
export const cancelAnnotationSession = async (host: AnnotationHost): Promise<void> => {
	try {
		await host.executeJavaScript(ANNOTATION_TEARDOWN_SCRIPT, false);
	} catch {
		// 页面导航走了或被销毁,overlay 随之消失。
	}
};

export const runAnnotationSession = async ({
	host,
	theme,
	labels,
}: {
	host: AnnotationHost;
	theme: AnnotationOverlayTheme;
	labels: AnnotationOverlayLabels;
}): Promise<AnnotationSessionResult | null> => {
	const script = buildAnnotationOverlayScript(theme, labels);
	const raw = await host.executeJavaScript(script, true);

	// 页面内取消。
	if (raw === null || raw === undefined) return null;

	if (!isAnnotationPayload(raw)) {
		await cancelAnnotationSession(host);
		return null;
	}
	const payload = raw;

	try {
		const viewport = (await readViewport(host)) ?? payload.viewport;
		const capture = await host.capturePage();
		if (!capture?.base64) {
			return { payload, screenshot: null };
		}

		const screenshot = await renderAnnotationScreenshot({
			base64: capture.base64,
			mime: capture.mime || "image/jpeg",
			captureWidth: capture.width,
			captureHeight: capture.height,
			cssWidth: viewport.width,
			cssHeight: viewport.height,
			payload,
			accentColor: theme.primary,
			accentFill: theme.primarySoft,
		});
		return { payload, screenshot };
	} catch {
		return { payload, screenshot: null };
	}
};
