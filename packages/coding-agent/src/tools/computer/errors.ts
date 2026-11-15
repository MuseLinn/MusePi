/**
 * Typed view over native desktop errors.
 *
 * The native session throws `Code: message` strings; napi-rs has no custom
 * error-code field, so the prefix IS the wire contract. This module parses it
 * once, at the boundary, and hands the rest of the tool a real `code` property
 * instead of making every call site match on message text.
 */

import { ToolError } from "../tool-errors";

/** Error codes the native desktop session can report. */
export const DESKTOP_ERROR_CODES = [
	"PermissionDenied",
	"CaptureFailed",
	"InputFailed",
	"BackgroundUnavailable",
	"WindowNotFound",
	"InvalidTarget",
	"InvalidKey",
	"InvalidCoordinateFrame",
	"StaleRef",
	"AxUnsupported",
	"AxFailed",
	"Timeout",
	"Closed",
	"Cancelled",
	"InputBusy",
	"Internal",
] as const;

export type DesktopErrorCode = (typeof DESKTOP_ERROR_CODES)[number];

const KNOWN = new Set<string>(DESKTOP_ERROR_CODES);
const PREFIX = /^([A-Za-z]+): ([\s\S]*)$/;

/** A desktop failure with its machine code preserved. */
export class DesktopToolError extends ToolError {
	readonly code: DesktopErrorCode;
	/** The message without its `Code: ` prefix. */
	readonly detail: string;

	constructor(code: DesktopErrorCode, message: string, detail: string = message) {
		super(message);
		this.name = "DesktopToolError";
		this.code = code;
		this.detail = detail;
	}
}

/** Split a native error message into its code and detail. Unknown codes keep
 *  the whole message and fall back to `Internal`. */
export function parseDesktopError(message: string): { code: DesktopErrorCode; detail: string } {
	const match = PREFIX.exec(message);
	if (match && KNOWN.has(match[1]!)) {
		return { code: match[1] as DesktopErrorCode, detail: match[2]! };
	}
	return { code: "Internal", detail: message };
}

/** Wrap anything a native call threw into a {@link DesktopToolError}. Abort
 *  errors are returned unchanged so callers can rethrow them as aborts. */
export function desktopErrorFrom(error: unknown): DesktopToolError {
	const message = error instanceof Error ? error.message : String(error);
	const { code, detail } = parseDesktopError(message);
	const wrapped = new DesktopToolError(code, message, detail);
	if (error instanceof Error && error.stack) wrapped.stack = error.stack;
	(wrapped as { cause?: unknown }).cause = error;
	return wrapped;
}
