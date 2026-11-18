import {
	Claude as ClaudeTop,
	CodeBuddy as CodeBuddyTop,
	Codex as CodexTop,
	DeepSeek as DeepSeekTop,
	Grok as GrokTop,
	Kimi as KimiTop,
	OpenCode as OpenCodeTop,
	Pi as PiTop,
} from "@lobehub/icons";
import Claude from "@lobehub/icons/es/Claude/components/Mono";
import CodeBuddy from "@lobehub/icons/es/CodeBuddy/components/Mono";
import Codex from "@lobehub/icons/es/Codex/components/Mono";
import DeepSeek from "@lobehub/icons/es/DeepSeek/components/Mono";
import Grok from "@lobehub/icons/es/Grok/components/Mono";
import Kimi from "@lobehub/icons/es/Kimi/components/Mono";
import OpenCode from "@lobehub/icons/es/OpenCode/components/Mono";
import Pi from "@lobehub/icons/es/Pi/components/Mono";
import WorkBuddy from "@lobehub/icons/es/WorkBuddy/components/Mono";
import type { FOREIGN_SESSION_SOURCE_IDS } from "@musepi/pi-coding-agent/session/foreign-session-source-ids";
import { Bot } from "lucide";
import { MorphIcon } from "morphicons/react";
import type { ComponentType, ReactNode } from "react";
import { useBrandIconStyle } from "../lib/brand-icon-style";

type IconComponent = ComponentType<{ size?: number }>;
type SourceBrand = { mono: IconComponent; color?: IconComponent };

/** Top-level Lobe exports are compound: the bare value is Mono, `.Color` is the colour variant. */
function pair(mono: IconComponent, compound?: unknown): SourceBrand {
	const colour = (compound as { Color?: unknown } | undefined)?.Color;
	return colour ? { mono, color: colour as IconComponent } : { mono };
}

export const SOURCE_BRANDS = {
	omp: pair(Pi, PiTop),
	pi: pair(Pi, PiTop),
	opencode: pair(OpenCode, OpenCodeTop),
	grok: pair(Grok, GrokTop),
	kimicode: pair(Kimi, KimiTop),
	workbuddy: pair(WorkBuddy),
	codebuddy: pair(CodeBuddy, CodeBuddyTop),
	dsh: pair(DeepSeek, DeepSeekTop),
	claude: pair(Claude, ClaudeTop),
	codex: pair(Codex, CodexTop),
} as const;

type SourceWithoutMark = Exclude<(typeof FOREIGN_SESSION_SOURCE_IDS)[number], keyof typeof SOURCE_BRANDS>;
const _everySourceHasAMark: SourceWithoutMark extends never ? true : never = true;

/** Source mark in the active style, or the generic bot for an unknown source. */
export function SourceGlyph({ source, size }: { source: string; size: number }): ReactNode {
	const style = useBrandIconStyle();
	const sourceBrand = SOURCE_BRANDS[source as keyof typeof SOURCE_BRANDS];
	const Brand = style === "color" ? (sourceBrand?.color ?? sourceBrand?.mono) : sourceBrand?.mono;
	if (Brand) return <Brand size={size} />;
	return <MorphIcon icon={Bot} size={size} spring="snappy" />;
}
