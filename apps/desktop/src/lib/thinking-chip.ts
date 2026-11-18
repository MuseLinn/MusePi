/**
 * 胶囊应显示的思考档位。
 *
 * 会话条目或全局默认可能报出一个当前模型没有的档位:模型切换时 daemon 会
 * 重新收紧会话档位,但不保证追加新的 `thinking_level_change`,于是转录里最后
 * 一条记录仍可能是旧模型的档位。此时以模型的真实 ladder 为准(`canonical`
 * 是 daemon 报告的会话档位,优先于猜一个)。
 *
 * `efforts === null` 表示 ladder 还没读到 —— 原样返回,避免首帧闪一下兜底档位;
 * 已知 `[]`(模型没有可调档位)才落到关闭思考。
 */
export function clampThinkingChipLevel(
	level: string | null,
	efforts: readonly string[] | null | undefined,
	canonical?: string | null,
): string | null {
	if (level === null) return canonical ?? null;
	if (efforts === null || efforts === undefined) return level;
	// auto 是「按任务自动选档」的模式,不是刻度;模型有刻度时保留,没有时关掉。
	if (level === "auto") return efforts.length > 0 ? level : (canonical ?? null);
	if (efforts.includes(level)) return level;
	return canonical ?? efforts[0] ?? null;
}
