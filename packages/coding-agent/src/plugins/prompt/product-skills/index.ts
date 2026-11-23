import type { PluginAPI } from "../../../extensibility/extensions/types";

export const name = "musepi-product-skills";
export const inject = [] as const;
export const provide = [] as const;

/** Package marker: the discovery provider owns this package's file skills. */
export function apply(ctx: PluginAPI): void {}
