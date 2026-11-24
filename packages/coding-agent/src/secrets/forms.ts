/**
 * The byte forms one secret can take in tool output: its raw text, the form
 * JSON.stringify escapes it to, and the form encodeURIComponent produces (with
 * `!'()*` escaped too, because a URL builder may percent-encode them and the
 * redactor has to recognise the form actually sent).
 *
 * A value can appear encoded without ever appearing raw — a token placed in a
 * query string, a key read from a JSON document — so redacting the raw value
 * alone leaves a provider-visible copy behind. Longest first so a form that
 * contains another is replaced whole.
 */
export function secretForms(value: string): string[] {
	const forms = new Set<string>([value]);
	const escaped = JSON.stringify(value).slice(1, -1);
	if (escaped !== value) forms.add(escaped);
	const wellFormed = typeof value.isWellFormed === "function" ? value.isWellFormed() : true;
	if (wellFormed) {
		const encoded = encodeURIComponent(value).replace(/[!'()*]/g, char => {
			return `%${char.charCodeAt(0).toString(16).toUpperCase()}`;
		});
		if (encoded !== value && encoded !== escaped) forms.add(encoded);
	}
	return [...forms].sort((left, right) => right.length - left.length);
}
