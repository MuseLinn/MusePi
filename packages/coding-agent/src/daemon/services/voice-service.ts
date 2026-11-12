import type { DaemonService } from "./types";

/**
 * VoiceService — 语音前端面（L2 宿主服务）：说话人身份登记与实时转写流。
 *
 * 能力缝声明：
 * - 名称/命名空间：`voice`；RPC `voice.speakerStatus` /
 *   `voice.speakerEnrollmentStart` / `voice.speakerEnrollmentAdd` /
 *   `voice.speakerEnrollmentFinish` / `voice.speakerEnrollmentCancel` /
 *   `voice.speakerDelete` / `voice.frontendProcess` /
 *   `voice.frontendStreamStart` / `voice.frontendStreamAudio` /
 *   `voice.frontendStreamStop` / `voice.frontendStreamCancel`。
 * - 输入：16 kHz 单声道采样（`number[]` 线上形状，入服务后转 Float32Array）、
 *   说话人模式 `off|prefer|strict`、可选登记样本与接受/拒绝阈值；流式路由按
 *   start 返回的 `sessionId` 寻址。参数校验与错误文案在服务内完成
 *   （`audio required`、`sampleRate must be 16000`、`invalid speakerMode`、
 *   `modelKey required`、`unknown speech model:`）。
 * - 输出：登记/状态/整段处理结果原样透传 `VoiceFrontendService`；`frontendStreamStart`
 *   返回 `{ sessionId }`，后续分片结果经注入的 `broadcast` 以
 *   `voice.frontendPartial` / `voice.frontendSegment` 全局事件下发。
 * - 生命周期：无自有资源——引擎进程、说话人档案与流句柄都归
 *   `voice/frontend/service` 的进程级单例；本服务只做校验与转发，动态
 *   import 保持引擎只在首次语音 RPC 时装载。
 * - 启停：随 daemon 注册表常驻；停用等同于不再收到语音 RPC，单例的引擎进程
 *   由其自身 close 语义回收。
 * - 冲突：路由唯一归属由 HostServices routeTable 强制；广播只经 `EventService`
 *   （注入回调），本服务不持有事件目标集，也不与 STT 模型管理路由重叠。
 */
export interface VoiceServiceDeps {
	/** 全局事件广播（server 注入 `EventService.broadcast`）。 */
	broadcast(payload: Record<string, unknown>): void;
}

export class VoiceService implements DaemonService {
	readonly key = "voice";
	readonly routes = {
		"voice.speakerStatus": "speakerStatus",
		"voice.speakerEnrollmentStart": "speakerEnrollmentStart",
		"voice.speakerEnrollmentAdd": "speakerEnrollmentAdd",
		"voice.speakerEnrollmentFinish": "speakerEnrollmentFinish",
		"voice.speakerEnrollmentCancel": "speakerEnrollmentCancel",
		"voice.speakerDelete": "speakerDelete",
		"voice.frontendProcess": "frontendProcess",
		"voice.frontendStreamStart": "frontendStreamStart",
		"voice.frontendStreamAudio": "frontendStreamAudio",
		"voice.frontendStreamStop": "frontendStreamStop",
		"voice.frontendStreamCancel": "frontendStreamCancel",
	} as const;

	readonly #deps: VoiceServiceDeps;

	constructor(deps: VoiceServiceDeps) {
		this.#deps = deps;
	}

	async speakerStatus() {
		const { getVoiceFrontendService } = await import("../../voice/frontend/service");
		return getVoiceFrontendService().status();
	}

	async speakerEnrollmentStart() {
		const { getVoiceFrontendService } = await import("../../voice/frontend/service");
		return getVoiceFrontendService().enrollmentStart();
	}

	async speakerEnrollmentAdd(params: unknown) {
		const p = (params ?? {}) as { audio?: number[]; sampleRate?: number };
		if (!Array.isArray(p.audio) || p.audio.length === 0) throw new Error("audio required");
		if (p.sampleRate !== undefined && p.sampleRate !== 16_000) throw new Error("sampleRate must be 16000");
		const { getVoiceFrontendService } = await import("../../voice/frontend/service");
		return getVoiceFrontendService().enrollmentAdd({ audio: p.audio, sampleRate: 16_000 });
	}

	async speakerEnrollmentFinish(params: unknown) {
		const p = (params ?? {}) as { audio?: number[]; sampleRate?: number };
		if (!Array.isArray(p.audio) || p.audio.length === 0) throw new Error("audio required");
		if (p.sampleRate !== undefined && p.sampleRate !== 16_000) throw new Error("sampleRate must be 16000");
		const { getVoiceFrontendService } = await import("../../voice/frontend/service");
		return getVoiceFrontendService().enrollmentFinish({ audio: p.audio, sampleRate: 16_000 });
	}

	async speakerEnrollmentCancel() {
		const { getVoiceFrontendService } = await import("../../voice/frontend/service");
		getVoiceFrontendService().enrollmentCancel();
		return { ok: true };
	}

	async speakerDelete() {
		const { getVoiceFrontendService } = await import("../../voice/frontend/service");
		await getVoiceFrontendService().speakerDelete();
		return { ok: true };
	}

	async frontendProcess(params: unknown) {
		const p = (params ?? {}) as {
			audio?: number[];
			sampleRate?: number;
			targetMs?: number;
			speakerMode?: "off" | "prefer" | "strict";
			enhanceAudio?: boolean;
			enrollment?: number[][];
			acceptThreshold?: number;
			rejectThreshold?: number;
		};
		if (!Array.isArray(p.audio) || p.audio.length === 0) throw new Error("audio required");
		if (p.sampleRate !== undefined && p.sampleRate !== 16_000) throw new Error("sampleRate must be 16000");
		if (p.speakerMode && !["off", "prefer", "strict"].includes(p.speakerMode)) throw new Error("invalid speakerMode");
		const { getVoiceFrontendService } = await import("../../voice/frontend/service");
		return getVoiceFrontendService().process({
			audio: Float32Array.from(p.audio),
			sampleRate: 16_000,
			targetMs: p.targetMs ?? (p.audio.length / 16_000) * 1000,
			speakerMode: p.speakerMode ?? "off",
			enhanceAudio: p.enhanceAudio ?? false,
			enrollment: p.enrollment,
			acceptThreshold: p.acceptThreshold,
			rejectThreshold: p.rejectThreshold,
		});
	}

	async frontendStreamStart(params: unknown) {
		const p = (params ?? {}) as {
			modelKey?: string;
			language?: string;
			speakerMode?: "off" | "prefer" | "strict";
			enhanceAudio?: boolean;
			enrollment?: number[][];
			acceptThreshold?: number;
			rejectThreshold?: number;
		};
		if (!p.modelKey) throw new Error("modelKey required");
		const { isSttModelKey } = await import("../../stt/models");
		if (!isSttModelKey(p.modelKey)) throw new Error(`unknown speech model: ${p.modelKey}`);
		if (p.speakerMode && !["off", "prefer", "strict"].includes(p.speakerMode)) throw new Error("invalid speakerMode");
		const { getVoiceFrontendService } = await import("../../voice/frontend/service");
		const sessionId = await getVoiceFrontendService().streamStart(
			{
				modelKey: p.modelKey,
				language: p.language,
				speakerMode: p.speakerMode ?? "off",
				enhanceAudio: p.enhanceAudio ?? false,
				enrollment: p.enrollment,
				acceptThreshold: p.acceptThreshold,
				rejectThreshold: p.rejectThreshold,
			},
			{
				onPartial: result => {
					this.#deps.broadcast({
						type: "voice.frontendPartial",
						sessionId,
						segmentId: result.segmentId,
						text: result.text,
						state: result.state,
					});
				},
				onSegment: result => {
					this.#deps.broadcast({
						type: "voice.frontendSegment",
						sessionId,
						segmentId: result.segmentId,
						text: result.text,
						state: result.state,
					});
				},
			},
		);
		return { sessionId };
	}

	async frontendStreamAudio(params: unknown) {
		const p = (params ?? {}) as { sessionId?: string; audio?: number[] };
		if (!p.sessionId) throw new Error("sessionId required");
		if (!Array.isArray(p.audio) || p.audio.length === 0) throw new Error("audio required");
		const { getVoiceFrontendService } = await import("../../voice/frontend/service");
		getVoiceFrontendService().streamAudio(p.sessionId, Float32Array.from(p.audio));
		return { ok: true };
	}

	async frontendStreamStop(params: unknown) {
		const p = (params ?? {}) as { sessionId?: string };
		if (!p.sessionId) throw new Error("sessionId required");
		const { getVoiceFrontendService } = await import("../../voice/frontend/service");
		return { results: await getVoiceFrontendService().streamStop(p.sessionId) };
	}

	async frontendStreamCancel(params: unknown) {
		const p = (params ?? {}) as { sessionId?: string };
		if (!p.sessionId) throw new Error("sessionId required");
		const { getVoiceFrontendService } = await import("../../voice/frontend/service");
		getVoiceFrontendService().streamCancel(p.sessionId);
		return { ok: true };
	}
}
