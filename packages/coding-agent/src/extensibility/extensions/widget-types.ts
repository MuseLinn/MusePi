/**
 * Widget metadata contributed by extensions (registerWidget).
 *
 * Deliberately dependency-free: plugin type declarations and the daemon's
 * validation table import this module, and keeping it free of the runtime
 * `types.ts` graph means a type-only consumer (the GUI parity test, a plugin
 * manifest) does not pull the whole agent runtime into its program.
 */

/** One widget type contributed by an extension (registerWidget). */
export interface ExtensionWidget {
	/** Registry key (`widget.type` / `board` card type). */
	type: string;
	/** Display name shown in the picker and card header (plugin-owned, so it
	 *  is plain text rather than a host i18n key). */
	label: string;
	/** Optional one-line description for the picker. */
	description?: string;
	fields: ExtensionWidgetField[];
	/** Fresh default data; called per registration so no shared object leaks. */
	defaults(): Record<string, unknown>;
	/** Card shell treatment; defaults to "default". */
	tone?: "default" | "dark" | "light" | "blue";
	/** Extension-relative renderer module (e.g. "./ui/metric.tsx"). */
	moduleUrl: string;
}

/** Field declaration shared by the board editor and the agent schema. */
export interface ExtensionWidgetField {
	key: string;
	type: "number" | "string" | "boolean" | "select";
	label?: string;
	options?: readonly string[];
	min?: number;
	max?: number;
	step?: number;
}
