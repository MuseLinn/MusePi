/**
 * Minimal replacements for @oh-my-pi/pi-utils helpers used by the advisor system.
 */

/** Check if an error is an ENOENT (file not found) filesystem error. */
export function isEnoent(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/** Check if an error is an EACCES (permission denied) filesystem error. */
export function isEacces(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && (err as NodeJS.ErrnoException).code === "EACCES";
}

/** Escape a string for use as an XML attribute value. */
export function escapeXmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/** Escape a string for use as XML text content. */
export function escapeXmlText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
