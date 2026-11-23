import type { ReleaseKey } from "../zh-CN/release.js";

export const release = {
	// 规范分类标题。
	"release heading new features": "New features",
	"release heading improvements": "Improvements",
	"release heading fixes": "Fixes",
	// 本次发布计数行。
	"release summary prefix": "This release:",
	"release summary empty": "no user-visible changes",
	// 计数项：数量后的名词短语（`2 new features`）。
	"release summary new feature one": "new feature",
	"release summary new feature many": "new features",
	"release summary improvement one": "improvement",
	"release summary improvement many": "improvements",
	"release summary fix one": "fix",
	"release summary fix many": "fixes",
	"release summary other change one": "other change",
	"release summary other change many": "other changes",
} as const satisfies Record<ReleaseKey, string>;
