/**
 * Companion drawing-style labels (vector orb / spritesheet), shared by the
 * companion settings page and onboarding personalization. The core
 * translation map is a frozen client-core dependency, so shell-owned strings
 * register here through the same runtime seam plugins use.
 *
 * Import this file for side effects wherever the style control renders.
 */
import { registerTranslations } from "@musepi/client-core";

const zhPetStyle = {
	"settings.petStyle": "桌宠形态",
	"settings.petStyleDescription": "矢量球体由代码绘制，雪碧图按行帧播放。",
	"settings.petStyleVector": "矢量球体",
	"settings.petStyleSprite": "雪碧图",
} as const;

registerTranslations("zh-CN", zhPetStyle);

registerTranslations("en-US", {
	"settings.petStyle": "Companion style",
	"settings.petStyleDescription": "Vector companions are drawn in code; spritesheets play frame rows.",
	"settings.petStyleVector": "Vector orb",
	"settings.petStyleSprite": "Spritesheet",
} as const satisfies Record<keyof typeof zhPetStyle, string>);
