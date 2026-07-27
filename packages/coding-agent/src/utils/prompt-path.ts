/** Normalize a file path for prompt display (forward slashes only). */
export function normalizePromptPath(value: string): string {
	return value.replace(/\\/g, "/");
}
