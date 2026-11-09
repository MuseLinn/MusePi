import { ToolError } from "../tool-errors";

export type BrowserDeviceProfileId =
	| "iphone-se"
	| "iphone-12-pro"
	| "iphone-14-pro"
	| "iphone-14-pro-max"
	| "pixel-7"
	| "galaxy-s20-ultra"
	| "ipad-mini"
	| "ipad-pro-13"
	| "iphone-duo-outer"
	| "iphone-duo-inner"
	| "iphone-16"
	| "iphone-16-pro"
	| "iphone-16-pro-max"
	| "pixel-8"
	| "pixel-9"
	| "desktop-1280"
	| "desktop-1440"
	| "desktop-1920"
	| "responsive";

export interface BrowserDeviceProfile {
	id: BrowserDeviceProfileId;
	width?: number;
	height?: number;
	mobile: boolean;
	touch: boolean;
}

export interface BrowserDeviceInput {
	enabled: boolean;
	orientation?: "portrait" | "landscape";
	profileId?: BrowserDeviceProfileId;
	scaleMode?: "fit" | "fixed";
	scale?: number;
	width?: number;
	height?: number;
}

export interface BrowserDeviceConfiguration {
	enabled: boolean;
	profileId?: BrowserDeviceProfileId;
	orientation?: "portrait" | "landscape";
	scaleMode?: "fit" | "fixed";
	scale?: number;
	viewport: {
		width: number;
		height: number;
		deviceScaleFactor: number;
		isMobile: boolean;
		hasTouch: boolean;
		isLandscape: boolean;
	} | null;
}

function profile(id: BrowserDeviceProfileId, width: number, height: number, mobile = true): BrowserDeviceProfile {
	return { id, width, height, mobile, touch: mobile };
}

export const BROWSER_DEVICE_PROFILES: readonly BrowserDeviceProfile[] = [
	profile("iphone-se", 375, 667),
	profile("iphone-12-pro", 390, 844),
	profile("iphone-14-pro", 393, 852),
	profile("iphone-14-pro-max", 430, 932),
	profile("pixel-7", 412, 915),
	profile("galaxy-s20-ultra", 412, 915),
	profile("ipad-mini", 768, 1024),
	profile("ipad-pro-13", 1032, 1376),
	profile("iphone-duo-outer", 466, 678),
	profile("iphone-duo-inner", 669, 951),
	profile("iphone-16", 393, 852),
	profile("iphone-16-pro", 402, 874),
	profile("iphone-16-pro-max", 440, 956),
	profile("pixel-8", 412, 915),
	profile("pixel-9", 412, 924),
	profile("desktop-1280", 1280, 800, false),
	profile("desktop-1440", 1440, 900, false),
	profile("desktop-1920", 1920, 1080, false),
	{ id: "responsive", mobile: true, touch: true },
];

export function resolveDeviceConfiguration(input: BrowserDeviceInput): BrowserDeviceConfiguration {
	if (!input.enabled) return { enabled: false, viewport: null };
	if (!input.profileId || !input.orientation || !input.scaleMode) {
		throw new ToolError("Enabling device mode requires profileId, orientation and scaleMode");
	}
	if (input.scaleMode === "fixed" && (!Number.isFinite(input.scale) || input.scale! < 0.01 || input.scale! > 1)) {
		throw new ToolError("Device fixed requires scale between 0.01 and 1");
	}
	if (input.scaleMode === "fit" && input.scale !== undefined) throw new ToolError("Device fit forbids scale");
	const responsive = input.profileId === "responsive";
	if (responsive && (!Number.isInteger(input.width) || !Number.isInteger(input.height))) {
		throw new ToolError("Responsive device mode requires width and height");
	}
	if (!responsive && (input.width !== undefined || input.height !== undefined)) {
		throw new ToolError("Device presets forbid explicit width and height");
	}
	if (responsive && (input.width! < 50 || input.width! > 9999 || input.height! < 50 || input.height! > 9999)) {
		throw new ToolError("Responsive width and height must be between 50 and 9999");
	}
	const selected = BROWSER_DEVICE_PROFILES.find(candidate => candidate.id === input.profileId);
	if (!selected) throw new ToolError(`Unknown device profile: ${input.profileId}`);
	const baseWidth = responsive ? input.width! : selected.width!;
	const baseHeight = responsive ? input.height! : selected.height!;
	const landscape = input.orientation === "landscape";
	const width = !responsive && landscape ? baseHeight : baseWidth;
	const height = !responsive && landscape ? baseWidth : baseHeight;
	return {
		enabled: true,
		profileId: selected.id,
		orientation: input.orientation,
		scaleMode: input.scaleMode,
		...(input.scaleMode === "fixed" ? { scale: input.scale! } : {}),
		viewport: {
			width,
			height,
			deviceScaleFactor: 1,
			isMobile: selected.mobile,
			hasTouch: selected.touch,
			isLandscape: landscape,
		},
	};
}

export function deviceActionCode(input: BrowserDeviceInput): string {
	const configuration = resolveDeviceConfiguration(input);
	return `await page.setViewport(${JSON.stringify(configuration.viewport)});\nreturn ${JSON.stringify(configuration)};`;
}
