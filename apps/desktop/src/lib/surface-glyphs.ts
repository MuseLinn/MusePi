import {
	BookOpen,
	Bot,
	ChartPie,
	Folder,
	GitBranch,
	Globe,
	Layers,
	ListChecks,
	ListTree,
	type LucideIcon,
	Sparkles,
} from "lucide-react";

/**
 * Lucide glyph for each built-in right-panel surface. The registry keeps the
 * oc-icon name for extension/fallback surfaces; tabs and the rail use this
 * stroke set so they can share the fill-wipe state animation.
 */
const SURFACE_GLYPHS: Record<string, LucideIcon> = {
	context: ChartPie,
	files: Folder,
	artifacts: Layers,
	trajectory: ListTree,
	jobs: ListChecks,
	git: GitBranch,
	notes: BookOpen,
	browser: Globe,
	agents: Bot,
	widget: Sparkles,
};

export function surfaceGlyph(id: string | null | undefined): LucideIcon | undefined {
	return id ? SURFACE_GLYPHS[id] : undefined;
}
