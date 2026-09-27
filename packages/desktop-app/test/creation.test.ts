import { describe, expect, test } from "bun:test";
import { buildProjectMetadata, DEFAULT_CREATION_DRAFT, hydrateDraftFromMetadata } from "../src/lib/creation";

/**
 * M3.2 creation metadata contracts (§4 契约):
 *
 * 1. buildProjectMetadata — 每 tab 的字段路由(设计稿 §3 各表"去向"列):
 *    prototype/live-artifact/other 带 platforms/fidelity/surfaceOptions;
 *    deck 只带 speakerNotes;media 只带 media 分支;live-artifact 特化为
 *    kind:"prototype" + intent:"live-artifact" 且强制 high-fidelity。
 * 2. hydrateDraftFromMetadata — 会话恢复原样回读:已知字段回填、缺省回落
 *    基准草稿、kind+intent 往返不漂移（验收"再入回填正确"的纯逻辑半边）。
 */

describe("buildProjectMetadata", () => {
	test("prototype: platform/fidelity/surfaceOptions routed, skillId null in M3.2", () => {
		const metadata = buildProjectMetadata({
			...DEFAULT_CREATION_DRAFT,
			tab: "prototype",
			name: "示例",
			platforms: ["responsive", "mobile-ios"],
			fidelity: "wireframe",
			landingPage: true,
			osWidgets: true,
		});
		expect(metadata).toMatchObject({
			version: 1,
			kind: "prototype",
			name: "示例",
			skillId: null,
			designSystemId: null,
			platforms: ["responsive", "mobile-ios"],
			fidelity: "wireframe",
			surfaceOptions: { landingPage: true, osWidgets: true },
		});
		expect(metadata.createdAt).toBeTypeOf("string");
		expect("speakerNotes" in metadata).toBe(false);
		expect("media" in metadata).toBe(false);
	});

	test("live artifact: kind prototype + intent, fidelity forced high-fidelity", () => {
		const metadata = buildProjectMetadata({
			...DEFAULT_CREATION_DRAFT,
			tab: "live-artifact",
			fidelity: "wireframe", // 面板不渲染该选择器,构建时强制覆盖
		});
		expect(metadata.kind).toBe("prototype");
		expect(metadata.intent).toBe("live-artifact");
		expect(metadata.fidelity).toBe("high-fidelity");
	});

	test("deck: speakerNotes only — no platform/fidelity leakage", () => {
		const metadata = buildProjectMetadata({ ...DEFAULT_CREATION_DRAFT, tab: "deck", speakerNotes: true });
		expect(metadata).toMatchObject({ version: 1, kind: "deck", speakerNotes: true });
		expect("platforms" in metadata).toBe(false);
		expect("fidelity" in metadata).toBe(false);
	});

	test("media image: provider/model/aspect + promptTemplate with id", () => {
		const metadata = buildProjectMetadata({
			...DEFAULT_CREATION_DRAFT,
			tab: "media",
			mediaKind: "image",
			mediaProvider: "agnes-image",
			mediaModel: "agnes-image-2.1-flash",
			mediaAspect: "16:9",
			mediaPromptTemplateId: "poster",
			mediaPrompt: "竖版海报",
		});
		expect(metadata.kind).toBe("media");
		expect(metadata.media).toEqual({
			kind: "image",
			provider: "agnes-image",
			model: "agnes-image-2.1-flash",
			aspect: "16:9",
			durationSec: null,
			voice: null,
			promptTemplate: { id: "poster", prompt: "竖版海报" },
		});
	});

	test("media audio speech: voice recorded, aspect null; no prompt when empty", () => {
		const metadata = buildProjectMetadata({
			...DEFAULT_CREATION_DRAFT,
			tab: "media",
			mediaKind: "audio",
			mediaAudioKind: "speech",
			mediaVoice: "warm-female",
			mediaDurationSec: 12,
			mediaPrompt: "",
		});
		expect(metadata.media).toEqual({
			kind: "audio",
			provider: null,
			model: null,
			aspect: null,
			durationSec: 12,
			voice: "warm-female",
			audioKind: "speech",
		});
	});

	test("other: kind other, platform block kept", () => {
		const metadata = buildProjectMetadata({ ...DEFAULT_CREATION_DRAFT, tab: "other", platforms: ["tablet"] });
		expect(metadata.kind).toBe("other");
		expect(metadata.platforms).toEqual(["tablet"]);
		expect(metadata.fidelity).toBe("high-fidelity");
	});
});

describe("hydrateDraftFromMetadata", () => {
	test("roundtrips a prototype snapshot (intent→tab included)", () => {
		const draft = {
			...DEFAULT_CREATION_DRAFT,
			tab: "live-artifact" as const,
			platforms: ["tablet"],
			fidelity: "wireframe" as const,
		};
		const restored = hydrateDraftFromMetadata(buildProjectMetadata(draft), DEFAULT_CREATION_DRAFT);
		expect(restored.tab).toBe("live-artifact");
		expect(restored.platforms).toEqual(["tablet"]);
		// live-artifact fidelity is force-overridden at build time (see the
		// builder contract test) — the roundtrip restores the forced value.
		expect(restored.fidelity).toBe("high-fidelity");
	});

	test("roundtrips media snapshots (aspect/duration/voice/promptTemplate)", () => {
		const draft = {
			...DEFAULT_CREATION_DRAFT,
			tab: "media" as const,
			mediaKind: "video" as const,
			mediaProvider: "agnes-video",
			mediaAspect: "9:16",
			mediaDurationSec: 16,
			mediaPromptTemplateId: "scene",
			mediaPrompt: "场景",
		};
		const restored = hydrateDraftFromMetadata(buildProjectMetadata(draft), DEFAULT_CREATION_DRAFT);
		expect(restored.mediaKind).toBe("video");
		expect(restored.mediaProvider).toBe("agnes-video");
		expect(restored.mediaAspect).toBe("9:16");
		expect(restored.mediaDurationSec).toBe(16);
		expect(restored.mediaPromptTemplateId).toBe("scene");
		expect(restored.mediaPrompt).toBe("场景");
	});

	test("unknown/absent fields fall back to the base draft (原样回读不炸)", () => {
		const restored = hydrateDraftFromMetadata(
			{ version: 1, kind: "prototype" },
			{ ...DEFAULT_CREATION_DRAFT, name: "keep" },
		);
		expect(restored.tab).toBe("prototype");
		expect(restored.name).toBe("keep");
		expect(restored.platforms).toEqual(DEFAULT_CREATION_DRAFT.platforms);
	});
});
