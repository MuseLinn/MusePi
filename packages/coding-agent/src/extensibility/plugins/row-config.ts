/**
 * Row config fields are JSON strings in the plugin manifest (there is no
 * object/array field type), so every package that accepts a list parses the
 * same way: an empty field means "no entries", malformed JSON or a non-string
 * entry fails the row's mount with a named reason.
 */
export function stringArrayFromRow(value: unknown, field: string): string[] {
	const raw = typeof value === "string" ? value.trim() : "";
	if (raw === "") return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`${field} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!Array.isArray(parsed) || parsed.some(entry => typeof entry !== "string" || entry.trim() === "")) {
		throw new Error(`${field} must be a JSON array of non-empty strings`);
	}
	return (parsed as string[]).map(entry => entry.trim());
}
