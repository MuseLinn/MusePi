import { collectDomainDuplicates } from "../merge-domains.js";
import { agents } from "./agents.js";
import { announcement } from "./announcement.js";
import { collab } from "./collab.js";
import { companion } from "./companion.js";
import { composer } from "./composer.js";
import { context } from "./context.js";
import { creation } from "./creation.js";
import { general } from "./general.js";
import { guest } from "./guest.js";
import { reward } from "./reward.js";
import { sessions } from "./sessions.js";
import { settings } from "./settings.js";
import { shell } from "./shell.js";
import { tools } from "./tools.js";
import { transcript } from "./transcript.js";
import { update } from "./update.js";

/**
 * zh-CN translation map — merged from per-domain modules (shell, composer,
 * settings, …) so keys are edited next to their feature. `TranslationKey`
 * is derived from this merged surface, so the domains stay type-checked
 * against every `t()` call site.
 */
export const zhCN = {
	...shell,
	...composer,
	...sessions,
	...context,
	...collab,
	...transcript,
	...settings,
	...agents,
	...tools,
	...companion,
	...general,
	...guest,
	...reward,
	...update,
	...creation,
	...announcement,
} as const;

// Module-load duplicate detection (fail-safe, dsh LocaleRuntime parity):
// a key landing in two domains is logged loudly and reported via
// zhCNDuplicates — it must never throw here (a duplicate key white-screened
// the whole GUI twice). Tests assert the report is empty (i18n.test.ts).
const parts = {
	shell,
	composer,
	sessions,
	context,
	collab,
	transcript,
	settings,
	agents,
	tools,
	companion,
	general,
	guest,
	reward,
	update,
	creation,
	announcement,
};

/** Cross-domain duplicate report (empty in a healthy tree). */
export const zhCNDuplicates = collectDomainDuplicates("zh-CN", parts);

/** 防缩小锚点:参与合并的域文件数(i18n parity 测试据此守卫)。 */
export const zhCNDomainCount = Object.keys(parts).length;
