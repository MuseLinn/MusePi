/**
 * 标注 payload 契约 —— 浏览器页、会话内 HTML 卡片、以及任何未来的标注宿主
 * 共用同一套词汇。
 *
 * payload 跨越信任边界:它由一段运行在我们不控制的页面里的脚本产出。消费方
 * 会解引用的每个字段都在这里校验,而不是只挑方便的查 —— 半合法的 payload
 * 否则会在很远的地方(prompt 格式化、截图合成)才抛错,离它的出处隔着一整条
 * 调用链。
 */

export type AnnotationRect = {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
};

export type AnnotationPoint = { readonly x: number; readonly y: number };

export type AnnotationElementAncestor = {
	readonly tag: string;
	readonly id?: string;
	readonly className?: string;
	readonly selectorPart: string;
};

/**
 * 单个 DOM 元素,描述得足够让智能体在源码里再次找到它:selector、可读的
 * 祖先路径、自己的盒模型,以及问"视觉改动"时通常要紧的计算样式。
 */
export type AnnotationElementTarget = {
	readonly tag: string;
	readonly text: string;
	readonly selector: string;
	readonly path: string;
	readonly bounds: AnnotationRect;
	readonly center: AnnotationPoint;
	readonly attributes: Readonly<Record<string, string>>;
	readonly computedStyle: Readonly<Record<string, string>>;
	readonly ancestry: ReadonlyArray<AnnotationElementAncestor>;
};

export type AnnotationElement = {
	readonly id: string;
	readonly element: AnnotationElementTarget;
};

/** 用户在页面某块区域上拖出的自由矩形。 */
export type AnnotationRegion = {
	readonly id: string;
	readonly rect: AnnotationRect;
};

/** 页面上手绘的自由笔迹。 */
export type AnnotationStroke = {
	readonly id: string;
	readonly points: ReadonlyArray<AnnotationPoint>;
	readonly bounds: AnnotationRect;
};

/**
 * 一次标注会话的完整结果:用户标记的一切、以及他们的批注。提交时一次性
 * 发出 —— 绝不逐点击发。
 */
export type AnnotationPayload = {
	readonly id: string;
	readonly pageUrl: string;
	readonly pageTitle: string;
	readonly viewport: { readonly width: number; readonly height: number };
	readonly devicePixelRatio: number;
	readonly comment: string;
	readonly elements: ReadonlyArray<AnnotationElement>;
	readonly regions: ReadonlyArray<AnnotationRegion>;
	readonly strokes: ReadonlyArray<AnnotationStroke>;
};

export const annotationTargetCount = (payload: AnnotationPayload): number =>
	payload.elements.length + payload.regions.length + payload.strokes.length;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const isStringRecord = (value: unknown): value is Record<string, string> =>
	isRecord(value) && Object.values(value).every(entry => typeof entry === "string");

const isAnnotationRect = (value: unknown): value is AnnotationRect =>
	isRecord(value) &&
	isFiniteNumber(value.x) &&
	isFiniteNumber(value.y) &&
	isFiniteNumber(value.width) &&
	isFiniteNumber(value.height);

const isAnnotationPoint = (value: unknown): value is AnnotationPoint =>
	isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y);

const isAncestor = (value: unknown): value is AnnotationElementAncestor =>
	isRecord(value) &&
	typeof value.tag === "string" &&
	typeof value.selectorPart === "string" &&
	(value.id === undefined || typeof value.id === "string") &&
	(value.className === undefined || typeof value.className === "string");

export const isAnnotationElementTarget = (value: unknown): value is AnnotationElementTarget =>
	isRecord(value) &&
	typeof value.tag === "string" &&
	typeof value.text === "string" &&
	typeof value.selector === "string" &&
	typeof value.path === "string" &&
	isAnnotationRect(value.bounds) &&
	isAnnotationPoint(value.center) &&
	isStringRecord(value.attributes) &&
	isStringRecord(value.computedStyle) &&
	Array.isArray(value.ancestry) &&
	value.ancestry.every(isAncestor);

const isAnnotationElement = (value: unknown): value is AnnotationElement =>
	isRecord(value) && typeof value.id === "string" && isAnnotationElementTarget(value.element);

const isAnnotationRegion = (value: unknown): value is AnnotationRegion =>
	isRecord(value) && typeof value.id === "string" && isAnnotationRect(value.rect);

const isAnnotationStroke = (value: unknown): value is AnnotationStroke =>
	isRecord(value) &&
	typeof value.id === "string" &&
	isAnnotationRect(value.bounds) &&
	Array.isArray(value.points) &&
	value.points.every(isAnnotationPoint);

export const isAnnotationPayload = (value: unknown): value is AnnotationPayload =>
	isRecord(value) &&
	typeof value.id === "string" &&
	typeof value.pageUrl === "string" &&
	typeof value.pageTitle === "string" &&
	typeof value.comment === "string" &&
	isRecord(value.viewport) &&
	isFiniteNumber(value.viewport.width) &&
	isFiniteNumber(value.viewport.height) &&
	isFiniteNumber(value.devicePixelRatio) &&
	Array.isArray(value.elements) &&
	value.elements.every(isAnnotationElement) &&
	Array.isArray(value.regions) &&
	value.regions.every(isAnnotationRegion) &&
	Array.isArray(value.strokes) &&
	value.strokes.every(isAnnotationStroke);
