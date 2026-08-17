import { describe, expect, it } from "bun:test";
import { ansiLineToHtml, highlightToCodeHtml } from "../src/components/transcript/highlight";

const fg = (r: number, g: number, b: number): string => `\x1b[38;2;${r};${g};${b}m`;

describe("ansiLineToHtml", () => {
	it("colors RGB segments and escapes code text", () => {
		const html = ansiLineToHtml(`${fg(255, 0, 0)}const${"\x1b[39m"} ${fg(0, 0, 255)}x${"\x1b[39m"}`);
		expect(html).toBe('<span style="color:rgb(255,0,0)">const</span> <span style="color:rgb(0,0,255)">x</span>');
	});

	it("escapes angle brackets inside tokens", () => {
		const html = ansiLineToHtml(`${fg(255, 128, 0)}<div>${"\x1b[39m"}`);
		expect(html).toContain("&lt;div&gt;");
		expect(html).not.toContain("<div>");
	});

	it("auto-closes a color split across lines (trailing newline inside token)", () => {
		// natives keeps `\n` inside the comment token: reset lands on next line.
		const first = ansiLineToHtml(`${fg(150, 150, 150)} hello`);
		const second = ansiLineToHtml(`\x1b[39mconst ${fg(255, 0, 0)}=${"\x1b[39m"}`);
		expect(first).toBe('<span style="color:rgb(150,150,150)"> hello</span>');
		expect(second).toBe('const <span style="color:rgb(255,0,0)">=</span>');
	});

	it("ignores stray resets and other SGR without an open span", () => {
		const html = ansiLineToHtml(`\x1b[39mplain \x1b[1mtext\x1b[39m`);
		expect(html).toBe("plain text");
	});

	it("leaves plain text untouched (unsupported language fallback)", () => {
		expect(ansiLineToHtml("def x(): pass")).toBe("def x(): pass");
	});
});

describe("highlightToCodeHtml", () => {
	it("wraps each line's tokens in a content span inside tr-code-line", () => {
		const out = `${fg(255, 0, 0)}const${"\x1b[39m"} x\n${fg(0, 0, 255)}y${"\x1b[39m"}`;
		expect(highlightToCodeHtml(out)).toBe(
			'<span class="tr-code-line"><span class="tr-code-line-content"><span style="color:rgb(255,0,0)">const</span> x</span></span>\n' +
				'<span class="tr-code-line"><span class="tr-code-line-content"><span style="color:rgb(0,0,255)">y</span></span></span>\n',
		);
	});

	it("drops the trailing newline before splitting so empty last lines stay clean", () => {
		expect(highlightToCodeHtml("a\n")).toBe('<span class="tr-code-line"><span class="tr-code-line-content">a</span></span>\n');
	});
});
