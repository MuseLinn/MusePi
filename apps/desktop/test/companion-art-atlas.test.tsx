import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SpriteSheetArt } from "../src/components/CompanionArt";
import {
	resolveSpriteAnimation,
	type SpritePackage,
	spriteAmbientActions,
	spriteBubbleTheme,
	spriteCustomActions,
} from "../src/lib/companion";

const atlasPackage: SpritePackage = {
	id: "kimi-musepi",
	displayName: "Kimi",
	spritesheet: "data:image/png;base64,AA==",
	width: 2048,
	height: 2304,
	format: "atlas",
	atlas: { frameWidth: 256, frameHeight: 288, rows: 9, columns: 8 },
	states: {
		idle: { row: 0, frames: 8, fps: 8, loop: true },
		running_left: { row: 1, frames: 7, fps: 12, loop: true },
		running_right: { row: 2, frames: 7, fps: 12, loop: true },
		working: { row: 3, frames: 4, fps: 10, loop: true },
		waiting: { row: 4, frames: 6, fps: 6, loop: true },
		failed: { row: 5, frames: 5, fps: 8, loop: true },
		idle_random_1: { row: 6, frames: 7, fps: 10, loop: false },
		idle_random_2: { row: 7, frames: 7, fps: 10, loop: false },
		celebrate: { row: 8, frames: 5, fps: 14, loop: false },
	},
	contentH: 180,
	importedAt: 1,
};

describe("atlas pet animation contract", () => {
	it("uses the declared row geometry, frame count and fps instead of the Petdex 8×9 scan", () => {
		expect(resolveSpriteAnimation(atlasPackage, "rest")).toMatchObject({
			frameW: 256,
			frameH: 288,
			columns: 8,
			rowCount: 9,
			row: 0,
			valid: 8,
			cycleMs: 1000,
			loop: true,
		});
		expect(resolveSpriteAnimation(atlasPackage, "working")).toMatchObject({ row: 3, valid: 4, cycleMs: 400 });
		expect(resolveSpriteAnimation(atlasPackage, "waiting")).toMatchObject({ row: 4, valid: 6, cycleMs: 1000 });
		expect(resolveSpriteAnimation(atlasPackage, "error")).toMatchObject({ row: 5 });
	});

	it("falls back without inventing missing hover or analyzing rows", () => {
		expect(resolveSpriteAnimation(atlasPackage, "hover")).toMatchObject({ row: 0 });
		expect(resolveSpriteAnimation(atlasPackage, "analyzing")).toMatchObject({ row: 3 });
		expect(
			resolveSpriteAnimation({ ...atlasPackage, states: { idle: atlasPackage.states!.idle! } }, "working"),
		).toMatchObject({
			row: 0,
		});
	});

	it("selects explicit running directions and package-owned one-shot actions", () => {
		expect(resolveSpriteAnimation(atlasPackage, "dragging", null, "right")).toMatchObject({ row: 2 });
		expect(resolveSpriteAnimation(atlasPackage, "dragging", null, "left")).toMatchObject({ row: 1 });
		expect(resolveSpriteAnimation(atlasPackage, "rest", "celebrate")).toMatchObject({
			row: 8,
			valid: 5,
			loop: false,
		});
		expect(spriteAmbientActions(atlasPackage)).toEqual(["idle_random_1", "idle_random_2"]);
		expect(spriteCustomActions(atlasPackage)).toEqual(["celebrate"]);
	});

	it("renders a finite one-shot cycle so animationend can restore the live session state", () => {
		const html = renderToStaticMarkup(
			<SpriteSheetArt
				mood="rest"
				src={atlasPackage.spritesheet}
				width={atlasPackage.width}
				height={atlasPackage.height}
				format="atlas"
				atlas={atlasPackage.atlas}
				states={atlasPackage.states}
				contentH={atlasPackage.contentH}
				action={{ name: "celebrate", nonce: 2 }}
			/>,
		);
		expect(html).toContain("steps(5)");
		expect(html).toContain("1 forwards");
		expect(html).not.toContain("steps(5) infinite");
	});

	it("keeps legacy Petdex timing and geometry unchanged", () => {
		const legacy: SpritePackage = {
			id: "legacy",
			displayName: "Legacy",
			spritesheet: "legacy.webp",
			width: 768,
			height: 936,
			rows: [6, 8, 8, 8, 8, 8, 6, 6, 6],
			importedAt: 1,
		};
		expect(resolveSpriteAnimation(legacy, "rest")).toMatchObject({
			frameW: 96,
			frameH: 104,
			columns: 8,
			rowCount: 9,
			valid: 6,
			cycleMs: 2400,
			loop: true,
		});
	});
});

describe("package bubble theme", () => {
	it("accepts a readable six-digit hex palette", () => {
		expect(
			spriteBubbleTheme({
				...atlasPackage,
				theme: { bubble: { background: "#5F6B62", foreground: "#FFFFFF", border: "#87928A" } },
			}),
		).toEqual({ background: "#5F6B62", foreground: "#FFFFFF", border: "#87928A" });
	});

	it("rejects insufficient contrast and malformed colors", () => {
		expect(
			spriteBubbleTheme({
				...atlasPackage,
				theme: { bubble: { background: "#FFFFFF", foreground: "#FFFF00", border: "#87928A" } },
			}),
		).toBeNull();
		expect(
			spriteBubbleTheme({
				...atlasPackage,
				theme: { bubble: { background: "red", foreground: "#FFFFFF", border: "#87928A" } },
			}),
		).toBeNull();
	});
});
