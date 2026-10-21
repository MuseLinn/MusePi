/**
 * 标注结果 → composer 的挂载通道。
 *
 * 一次 CustomEvent 同时带文本与截图 File:composer 把文本追加进草稿、把
 * 附图走普通图片附件管线(addFiles)。事件没人听时(非桌面宿主)静默无事,
 * 标注入口在那些宿主上本来也不存在(沙箱卡片的 annotateCapture 由桌面
 * 渲染器提供)。
 */

export const ANNOTATION_ATTACH_EVENT = "musepi-gui-attach-annotation";

export interface AnnotationAttachDetail {
	/** 已格式化的标注 prompt(英文正文 + 本地化 intro)。 */
	readonly text: string;
	/** 画了标记的页面截图;捕获失败时为 undefined(prompt 里如实写 not attached)。 */
	readonly image?: File;
}

export function dispatchAnnotationAttach(detail: AnnotationAttachDetail): void {
	window.dispatchEvent(new CustomEvent<AnnotationAttachDetail>(ANNOTATION_ATTACH_EVENT, { detail }));
}
