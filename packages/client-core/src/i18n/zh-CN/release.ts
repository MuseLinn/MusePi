/**
 * 发布说明域 — 更新提示与「本次更新」面板共用的变更分类标题、本次发布
 * 计数行及单条变更的英文投影。
 * 中文是发布说明的规范结构（`### 新功能/改进/修复`、`本次发布：…`），
 * 此处也是解析 token 的唯一来源，避免展示文案与解析词各写一份。
 */
export const release = {
	// 规范分类标题。
	"release heading new features": "新功能",
	"release heading improvements": "改进",
	"release heading fixes": "修复",
	// 本次发布计数行。
	"release summary prefix": "本次发布：",
	"release summary empty": "无用户可见变更",
	// 计数项：数量后紧跟的量词短语（`2 项新功能`）。
	"release summary new feature one": "项新功能",
	"release summary new feature many": "项新功能",
	"release summary improvement one": "项改进",
	"release summary improvement many": "项改进",
	"release summary fix one": "项修复",
	"release summary fix many": "项修复",
	"release summary other change one": "项其他变更",
	"release summary other change many": "项其他变更",
} as const;

/** Key union for the release domain (source of truth). */
export type ReleaseKey = keyof typeof release;
