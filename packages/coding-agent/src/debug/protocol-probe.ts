/**
 * Terminal protocol smoke-test panel for the debug menu.
 *
 * Exercises special terminal protocols so a human can eyeball which ones
 * the active terminal actually honors:
 *   - SGR text styling + 24-bit truecolor
 *   - Hyperlinks (OSC 8)
 *   - Inline graphics (Kitty / iTerm2 / Sixel)
 */
import * as zlib from "node:zlib";
import { Container, getCapabilities, Image, type ImageDimensions, Spacer, Text } from "@musepi/pi-tui";
import { DynamicBorder } from "../modes/interactive/components/dynamic-border.ts";
import { theme } from "../modes/interactive/theme/theme.ts";

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** Frame a PNG chunk: 4-byte big-endian length, type+data, then the CRC-32 of type+data. */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const length = new Uint8Array(4);
	new DataView(length.buffer).setUint32(0, data.length, false);

	const typeBytes = new TextEncoder().encode(type);
	const crcData = new Uint8Array(typeBytes.length + data.length);
	crcData.set(typeBytes, 0);
	crcData.set(data, typeBytes.length);

	const crc = new Uint8Array(4);
	new DataView(crc.buffer).setUint32(0, zlib.crc32(crcData), false);

	const result = new Uint8Array(length.length + typeBytes.length + data.length + crc.length);
	let offset = 0;
	result.set(length, offset);
	offset += length.length;
	result.set(typeBytes, offset);
	offset += typeBytes.length;
	result.set(data, offset);
	offset += data.length;
	result.set(crc, offset);
	return result;
}

/**
 * Encode raw 8-bit RGB pixels (`width * height * 3` bytes, row-major) as a PNG
 * in memory — no file I/O, no external tools.
 */
export function encodeRgbPng(width: number, height: number, rgb: Uint8Array): Uint8Array {
	const ihdr = new Uint8Array(13);
	const dv = new DataView(ihdr.buffer);
	dv.setUint32(0, width, false);
	dv.setUint32(4, height, false);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // color type: RGB
	ihdr[10] = 0; // compression
	ihdr[11] = 0; // filter
	ihdr[12] = 0; // interlace

	// Build raw image data with filter byte per row
	const rowSize = 1 + width * 3; // filter byte + RGB pixels
	const raw = new Uint8Array(height * rowSize);
	for (let y = 0; y < height; y++) {
		const rowOffset = y * rowSize;
		raw[rowOffset] = 0; // filter: None
		raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), rowOffset + 1);
	}

	const compressed = zlib.deflateSync(raw);

	const dataLength =
		8 +
		pngChunk("IHDR", ihdr).length +
		pngChunk("IDAT", compressed).length +
		pngChunk("IEND", new Uint8Array(0)).length;
	const result = new Uint8Array(dataLength);
	let offset = 0;
	result.set(PNG_SIGNATURE, offset);
	offset += PNG_SIGNATURE.length;
	result.set(pngChunk("IHDR", ihdr), offset);
	offset += pngChunk("IHDR", ihdr).length;
	result.set(pngChunk("IDAT", compressed), offset);
	offset += pngChunk("IDAT", compressed).length;
	result.set(pngChunk("IEND", new Uint8Array(0)), offset);
	return result;
}

export interface SampleImage {
	base64: string;
	mimeType: string;
	dimensions: ImageDimensions;
}

/** Build a deterministic RGB gradient PNG. */
export function buildSampleImage(width = 192, height = 128): SampleImage {
	const rgb = new Uint8Array(width * height * 3);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 3;
			rgb[i] = Math.round((x / width) * 255); // red gradient across
			rgb[i + 1] = Math.round((y / height) * 255); // green gradient down
			rgb[i + 2] = 128; // constant blue
		}
	}
	const png = encodeRgbPng(width, height, rgb);
	return {
		base64: Buffer.from(png).toString("base64"),
		mimeType: "image/png",
		dimensions: { widthPx: width, heightPx: height },
	};
}

/** HSV (h in degrees, s/v in 0..1) to 8-bit RGB, for the truecolor demo bar. */
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
	const c = v * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = v - c;
	let r = 0,
		g = 0,
		b = 0;
	if (h < 60) {
		r = c;
		g = x;
	} else if (h < 120) {
		r = x;
		g = c;
	} else if (h < 180) {
		g = c;
		b = x;
	} else if (h < 240) {
		g = x;
		b = c;
	} else if (h < 300) {
		r = x;
		b = c;
	} else {
		r = c;
		b = x;
	}
	return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** A 24-bit-color hue sweep rendered as background-painted cells. */
function truecolorBar(cells: number): string {
	const parts: string[] = [];
	for (let i = 0; i < cells; i++) {
		const [r, g, b] = hsvToRgb((i / cells) * 360, 1, 1);
		parts.push(`\x1b[48;2;${r};${g};${b}m \x1b[0m`);
	}
	return parts.join("");
}

export interface ProtocolProbeOptions {
	image: SampleImage;
}

/**
 * Self-contained panel that renders one sample of every special terminal
 * protocol into the chat transcript.
 */
export class ProtocolProbeComponent extends Container {
	constructor(options: ProtocolProbeOptions) {
		super();

		const caps = getCapabilities();
		const yesNo = (on: boolean) => (on ? theme.fg("success", "supported") : theme.fg("muted", "unsupported"));

		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", "Terminal Protocol Test")), 1, 0));

		// Styling: SGR attributes, themed foregrounds, and a truecolor sweep.
		const styling = [
			theme.fg("muted", "Styling (SGR)"),
			`  ${theme.bold("bold")}  ${theme.italic("italic")}  ${theme.underline("underline")}  ${theme.strikethrough("strikethrough")}  ${theme.inverse(" inverse ")}  ${theme.fg("dim", "dim")}`,
			`  ${theme.fg("accent", "accent")}  ${theme.fg("success", "success")}  ${theme.fg("warning", "warning")}  ${theme.fg("error", "error")}`,
			`  truecolor: ${truecolorBar(32)} (${theme.fg("muted", `24-bit ${caps.trueColor ? "on" : "off"}`)})`,
		].join("\n");
		this.addChild(new Text(styling, 1, 0));
		this.addChild(new Spacer(1));

		// Hyperlinks: OSC 8.
		this.addChild(
			new Text(
				[
					`${theme.fg("muted", "Hyperlinks (OSC 8)")} — ${yesNo(caps.hyperlinks)}`,
					`  \x1b]8;;https://github.com/MuseLinn/MusePi\x07MusePi repo\x1b]8;;\x07`,
				].join("\n"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));

		// Graphics: inline image.
		this.addChild(new Text(`${theme.fg("muted", "Graphics")} — ${yesNo(caps.images !== null)}`, 1, 0));
		this.addChild(
			new Image(
				options.image.base64,
				options.image.mimeType,
				{ fallbackColor: (text: string) => theme.fg("toolOutput", text) },
				{ maxWidthCells: 20, maxHeightCells: 16 },
				options.image.dimensions,
			),
		);
		this.addChild(new Spacer(1));

		this.addChild(new DynamicBorder());
	}
}
