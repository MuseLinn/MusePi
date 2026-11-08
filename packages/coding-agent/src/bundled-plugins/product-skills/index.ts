import type { ExtensionAPI } from "../../extensibility/extensions/types";

/** Package marker: the discovery provider owns this package's file skills. */
export function apply(ctx: ExtensionAPI): void {
	ctx.setLabel("MusePi 产品技能");
}
