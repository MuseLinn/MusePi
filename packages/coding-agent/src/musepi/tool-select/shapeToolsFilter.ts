// ============================================================
// Tool-Select ShapeTools Filter — shared mutable handler
//
// Bridge between the transformProviderContext chain in sdk.ts
// and the tool-select extension's shapeTools() filter.
//
// The sdk.ts compose chain calls getShapeToolsHandler() if set;
// the tool-select extension registers its handler via setShapeToolsHandler().
// ============================================================

import type { Context, Model } from "@musepi/pi-ai";

export type ShapeToolsHandler = (context: Context, model: Model) => Context | Promise<Context>;

let handler: ShapeToolsHandler | undefined;

/** Register the tool-select shapeTools filter function. */
export function setShapeToolsHandler(fn: ShapeToolsHandler | undefined): void {
	handler = fn;
}

/** Get the registered shapeTools filter, if any. */
export function getShapeToolsHandler(): ShapeToolsHandler | undefined {
	return handler;
}
