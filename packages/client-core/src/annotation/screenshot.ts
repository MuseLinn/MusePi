/**
 * 把页面捕获 + 标注 payload 合成智能体收到的那张图。
 *
 * 图是整页可见区,标记画在上面 —— 不是贴着目标的裁剪。贴身的裁剪回答了
 * "这个元素长什么样",却毁掉了"它在哪、旁边是什么"这一半信息,而后者通常
 * 才是指着某个东西时更有用的那一半。
 *
 * 捕获以设备像素到达,而 payload 里每个矩形都是 CSS 像素,所以一切按两者
 * 的比值缩放,而不是按 devicePixelRatio —— 页面可能被缩放,实测比值在那种
 * 情况下仍然正确。
 *
 * 两个入口同源:{@link renderAnnotationScreenshot} 吃 webview 原生捕获
 * (base64);{@link renderAnnotationScreenshotFromBlob} 吃沙箱卡片
 * rasterize 出的 blob(卡片无页面缩放,capture/css 比值即像素比)。
 */
import type { AnnotationPayload, AnnotationRect } from "./contract";

const MAX_OUTPUT_WIDTH = 1600;

const loadImage = (src: string): Promise<HTMLImageElement> =>
	new Promise((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error("Failed to decode page capture"));
		image.src = src;
	});

const composite = async ({
	image,
	captureWidth,
	captureHeight,
	cssWidth,
	cssHeight,
	payload,
	accentColor,
	accentFill,
}: {
	image: HTMLImageElement;
	captureWidth: number;
	captureHeight: number;
	cssWidth: number;
	cssHeight: number;
	payload: AnnotationPayload;
	accentColor: string;
	accentFill: string;
}): Promise<File | null> => {
	try {
		const pixelWidth = Math.max(1, image.naturalWidth || captureWidth);
		const pixelHeight = Math.max(1, image.naturalHeight || captureHeight);
		const scaleX = pixelWidth / Math.max(1, cssWidth || pixelWidth);
		const scaleY = pixelHeight / Math.max(1, cssHeight || pixelHeight);

		const outputScale = Math.min(1, MAX_OUTPUT_WIDTH / pixelWidth);
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.floor(pixelWidth * outputScale));
		canvas.height = Math.max(1, Math.floor(pixelHeight * outputScale));
		const context = canvas.getContext("2d");
		if (!context) return null;

		context.scale(outputScale, outputScale);
		context.drawImage(image, 0, 0, pixelWidth, pixelHeight);

		/** CSS 像素 → 捕获像素;canvas 变换处理其余部分。 */
		const toCanvas = (rect: AnnotationRect): AnnotationRect => ({
			x: rect.x * scaleX,
			y: rect.y * scaleY,
			width: rect.width * scaleX,
			height: rect.height * scaleY,
		});

		// 轮廓跟着图一起缩,整页缩到输出宽度后仍然可见;1600px 宽的页面上
		// 一根发丝线会丢。
		const outlineWidth = Math.max(2, (2.5 * scaleX) / Math.max(outputScale, 0.2));
		context.strokeStyle = accentColor;
		context.fillStyle = accentFill;

		const markRect = (rect: AnnotationRect): void => {
			const box = toCanvas(rect);
			context.lineWidth = outlineWidth;
			context.fillRect(box.x, box.y, box.width, box.height);
			context.strokeRect(box.x, box.y, box.width, box.height);
		};

		for (const entry of payload.elements) markRect(entry.element.bounds);
		for (const region of payload.regions) markRect(region.rect);

		for (const stroke of payload.strokes) {
			if (stroke.points.length < 2) continue;
			context.beginPath();
			stroke.points.forEach((point, index) => {
				const x = point.x * scaleX;
				const y = point.y * scaleY;
				if (index === 0) context.moveTo(x, y);
				else context.lineTo(x, y);
			});
			context.lineCap = "round";
			context.lineJoin = "round";
			context.lineWidth = outlineWidth * 1.4;
			context.stroke();
		}

		const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.85));
		if (!blob) return null;
		return new File([blob], `annotation-${Date.now()}.jpg`, { type: "image/jpeg" });
	} catch {
		return null;
	}
};

export const renderAnnotationScreenshot = async ({
	base64,
	mime,
	captureWidth,
	captureHeight,
	cssWidth,
	cssHeight,
	payload,
	accentColor,
	accentFill,
}: {
	base64: string;
	mime: string;
	captureWidth: number;
	captureHeight: number;
	cssWidth: number;
	cssHeight: number;
	payload: AnnotationPayload;
	/** 实心轮廓色。 */
	accentColor: string;
	/**
	 * 半透明填充,由调用方解析好传进来。绝不靠给 accentColor 追加 alpha 后缀
	 * 推导:主题色不一定是 hex,非法值会把 canvas 留在默认的不透明黑上,涂掉
	 * 截图本来要展示的那个元素。
	 */
	accentFill: string;
}): Promise<File | null> => {
	if (!base64) return null;
	try {
		const image = await loadImage(`data:${mime};base64,${base64}`);
		return await composite({
			image,
			captureWidth,
			captureHeight,
			cssWidth,
			cssHeight,
			payload,
			accentColor,
			accentFill,
		});
	} catch {
		return null;
	}
};

/** 沙箱卡片版:来源是 rasterize 出的 blob(cssWidth/cssHeight = 卡片视口)。 */
export const renderAnnotationScreenshotFromBlob = async ({
	blob,
	cssWidth,
	cssHeight,
	payload,
	accentColor,
	accentFill,
}: {
	blob: Blob;
	cssWidth: number;
	cssHeight: number;
	payload: AnnotationPayload;
	accentColor: string;
	accentFill: string;
}): Promise<File | null> => {
	try {
		const url = URL.createObjectURL(blob);
		try {
			const image = await loadImage(url);
			return await composite({
				image,
				captureWidth: image.naturalWidth,
				captureHeight: image.naturalHeight,
				cssWidth,
				cssHeight,
				payload,
				accentColor,
				accentFill,
			});
		} finally {
			URL.revokeObjectURL(url);
		}
	} catch {
		return null;
	}
};
