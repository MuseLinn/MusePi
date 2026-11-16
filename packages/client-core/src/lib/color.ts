/**
 * Resolve a CSS colour (oklch/rgb/hsl/…) to `#rrggbb`.
 *
 * The token file authors accents in oklch, and both the native chrome and the
 * shell's swatches need plain rgb. `getComputedStyle` keeps the authored colour
 * space, so parsing the string would mean re-implementing CSS colour 4; a 1px
 * canvas lets the engine do it and hands back bytes.
 */
export function cssColorToHex(value: string): string {
	const input = value.trim();
	if (!input) return "";
	// A hex value is already what the caller wants — skip the canvas.
	if (/^#[0-9a-f]{6}$/i.test(input)) return input.toLowerCase();
	try {
		const canvas = document.createElement("canvas");
		canvas.width = 1;
		canvas.height = 1;
		const ctx = canvas.getContext("2d");
		if (!ctx) return "";
		ctx.fillStyle = "#000000";
		ctx.fillStyle = input; // invalid values keep the previous assignment
		ctx.fillRect(0, 0, 1, 1);
		const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
		const to = (n: number | undefined): string => (n ?? 0).toString(16).padStart(2, "0");
		return `#${to(r)}${to(g)}${to(b)}`;
	} catch {
		return "";
	}
}
