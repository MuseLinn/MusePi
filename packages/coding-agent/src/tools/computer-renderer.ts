import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { framedBlock, renderStatusLine } from "../tui";
import type { ComputerToolDetails } from "./computer";
import { replaceTabs, truncateToWidth } from "./render-utils";

interface ComputerRenderArgs {
	actions?: Array<{ type?: unknown }>;
}

interface ComputerRenderResult {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
}

function clean(value: unknown, width = 100): string {
	const text = typeof value === "string" ? value : JSON.stringify(value) || String(value);
	return truncateToWidth(replaceTabs(sanitizeText(text)).replace(/[\r\n]+/g, " "), width);
}

function isComputerToolDetails(value: unknown): value is ComputerToolDetails {
	if (!value || typeof value !== "object") return false;
	const details = value as Partial<ComputerToolDetails>;
	return (
		Array.isArray(details.actions) &&
		Array.isArray(details.displays) &&
		typeof details.width === "number" &&
		typeof details.height === "number"
	);
}

function actionDescription(args: ComputerRenderArgs | undefined): string | undefined {
	if (!Array.isArray(args?.actions) || args.actions.length === 0) return undefined;
	return clean(args.actions.map(action => (typeof action?.type === "string" ? action.type : "action")).join(" → "));
}

function resultDescription(details: ComputerToolDetails): string {
	return clean(`${details.actions.join(" → ")} · ${details.width}×${details.height}`, 120);
}

function errorDescription(result: ComputerRenderResult, args: ComputerRenderArgs | undefined): string | undefined {
	const text = result.content.find(item => item.type === "text" && typeof item.text === "string")?.text;
	return text ? clean(text, 120) : actionDescription(args);
}

export const computerToolRenderer = {
	mergeCallAndResult: true,
	renderCall(args: ComputerRenderArgs, _options: RenderResultOptions, theme: Theme): Component {
		return new Text(
			renderStatusLine({ icon: "pending", title: "Computer", description: actionDescription(args) }, theme),
			0,
			0,
		);
	},
	renderResult(
		result: ComputerRenderResult,
		options: RenderResultOptions,
		theme: Theme,
		args?: ComputerRenderArgs,
	): Component {
		const details = isComputerToolDetails(result.details) ? result.details : undefined;
		const header = renderStatusLine(
			result.isError
				? { icon: "error", title: "Computer", description: errorDescription(result, args) }
				: { icon: "success", title: "Computer", description: details ? resultDescription(details) : undefined },
			theme,
		);
		if (!details) return new Text(header, 0, 0);
		return framedBlock(theme, width => {
			const body: string[] = [
				theme.fg(
					"dim",
					`backend ${clean(details.backend)}${details.displayServer ? ` · server ${clean(details.displayServer)}` : ""} · capture ${clean(details.capturePermission)} · input ${clean(details.inputPermission)} · ${details.displays.length} display(s)`,
				),
			];
			const displayLimit = options.expanded ? details.displays.length : Math.min(details.displays.length, 3);
			for (const display of details.displays.slice(0, displayLimit)) {
				body.push(
					theme.fg(
						"toolOutput",
						clean(
							`${display.id}${display.name ? ` ${display.name}` : ""}: logical ${display.x},${display.y} ${display.width}×${display.height}; pixels ${display.pixelX},${display.pixelY} ${display.pixelWidth}×${display.pixelHeight}; scale ${display.scale}${display.isPrimary ? "; primary" : ""}`,
							160,
						),
					),
				);
			}
			if (displayLimit < details.displays.length) {
				body.push(theme.fg("dim", `… ${details.displays.length - displayLimit} more display(s)`));
			}
			if (details.capabilities) {
				body.push(theme.fg("dim", `capabilities ${clean(details.capabilities, 160)}`));
			}
			return {
				header,
				sections: [{ lines: body }],
				state: result.isError ? "error" : "success",
				borderColor: result.isError ? "error" : "borderMuted",
				applyBg: false,
				width,
			};
		});
	},
};
