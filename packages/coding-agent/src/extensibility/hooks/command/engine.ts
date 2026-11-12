import { type RunCommandHookOptions, runCommandHook } from "./executor";
import { selectHookGroups } from "./matcher";
import { mergeHookOutputs } from "./merge";
import type { CommandHookConfig, CommandHookEvent, HookDialect, HookRunRecord, MergedHookOutcome } from "./types";

/**
 * Run every hook matching one point, serially, in config order.
 *
 * Serial execution is what makes the merged outcome deterministic and keeps an
 * invoked/result pair adjacent in any log. Every matched hook runs even after
 * one blocks: the remaining hooks may carry context or warnings that still
 * describe the same event, and their side effects are already configured.
 */

export interface HookPointResult {
	merged: MergedHookOutcome;
	records: HookRunRecord[];
}

export async function runHookPoint(
	config: CommandHookConfig,
	dialect: HookDialect,
	point: CommandHookEvent,
	query: string,
	payload: unknown,
	options: Omit<RunCommandHookOptions, "expectedEventName">,
): Promise<HookPointResult> {
	const groups = selectHookGroups(config[point], query, dialect);
	const records: HookRunRecord[] = [];
	for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
		const group = groups[groupIndex];
		if (!group) continue;
		for (const hook of group.hooks) {
			const result = await runCommandHook(hook, payload, {
				...options,
				expectedEventName: point,
			});
			records.push({ group: groupIndex, hook, output: result.output, durationMs: result.durationMs });
		}
	}
	return { merged: mergeHookOutputs(records.map(record => record.output)), records };
}
