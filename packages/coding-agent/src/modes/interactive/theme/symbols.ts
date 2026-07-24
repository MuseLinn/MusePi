/**
 * Symbol preset system — ported from oh-my-pi.
 *
 * Provides Unicode and ASCII fallback symbols for all UI elements:
 * status indicators, navigation, tree connectors, box drawing, separators,
 * icons (tools, languages, tabs), spinner frames, etc.
 *
 * The `getSymbolTheme(theme?)` helper optionally accepts a Theme to return
 * pre-colored symbols via ThemeColor lookups.
 */

import type { Theme } from "./theme.ts";

// ============================================================================
// Types
// ============================================================================

export type SymbolPreset = "unicode" | "ascii";

export type SymbolKey =
	// Status indicators
	| "status.success"
	| "status.error"
	| "status.warning"
	| "status.info"
	| "status.pending"
	| "status.disabled"
	| "status.enabled"
	| "status.running"
	| "status.shadowed"
	| "status.aborted"
	| "status.done"
	// Navigation
	| "nav.cursor"
	| "nav.selected"
	| "nav.expand"
	| "nav.collapse"
	| "nav.back"
	// Tree connectors
	| "tree.branch"
	| "tree.last"
	| "tree.vertical"
	| "tree.horizontal"
	| "tree.hook"
	// Box drawing - rounded
	| "boxRound.topLeft"
	| "boxRound.topRight"
	| "boxRound.bottomLeft"
	| "boxRound.bottomRight"
	| "boxRound.horizontal"
	| "boxRound.vertical"
	// Box drawing - sharp
	| "boxSharp.topLeft"
	| "boxSharp.topRight"
	| "boxSharp.bottomLeft"
	| "boxSharp.bottomRight"
	| "boxSharp.horizontal"
	| "boxSharp.vertical"
	| "boxSharp.cross"
	| "boxSharp.teeDown"
	| "boxSharp.teeUp"
	| "boxSharp.teeRight"
	| "boxSharp.teeLeft"
	// Separators
	| "sep.powerline"
	| "sep.powerlineThin"
	| "sep.powerlineLeft"
	| "sep.powerlineRight"
	| "sep.powerlineThinLeft"
	| "sep.powerlineThinRight"
	| "sep.block"
	| "sep.space"
	| "sep.asciiLeft"
	| "sep.asciiRight"
	| "sep.dot"
	| "sep.slash"
	| "sep.pipe"
	// Icons
	| "icon.model"
	| "icon.plan"
	| "icon.prewalk"
	| "icon.goal"
	| "icon.pause"
	| "icon.loop"
	| "icon.folder"
	| "icon.worktree"
	| "icon.search"
	| "icon.scratchFolder"
	| "icon.file"
	| "icon.git"
	| "icon.branch"
	| "icon.pr"
	| "icon.tokens"
	| "icon.context"
	| "icon.cost"
	| "icon.time"
	| "icon.pi"
	| "icon.ghost"
	| "icon.agents"
	| "icon.job"
	| "icon.cache"
	| "icon.cacheMiss"
	| "icon.input"
	| "icon.output"
	| "icon.throughput"
	| "icon.host"
	| "icon.session"
	| "icon.package"
	| "icon.warning"
	| "icon.rewind"
	| "icon.auto"
	| "icon.fast"
	| "icon.extensionSkill"
	| "icon.extensionTool"
	| "icon.extensionSlashCommand"
	| "icon.extensionMcp"
	| "icon.extensionRule"
	| "icon.extensionHook"
	| "icon.extensionPrompt"
	| "icon.extensionContextFile"
	| "icon.extensionInstruction"
	| "icon.mic"
	| "icon.camera"
	// Thinking levels
	| "thinking.minimal"
	| "thinking.low"
	| "thinking.medium"
	| "thinking.high"
	| "thinking.xhigh"
	| "thinking.max"
	| "thinking.autoPending"
	// Checkboxes
	| "checkbox.checked"
	| "checkbox.unchecked"
	// Radio
	| "radio.selected"
	| "radio.unselected"
	// Text formatting
	| "format.bullet"
	| "format.dash"
	| "format.bracketLeft"
	| "format.bracketRight"
	// Markdown
	| "md.quoteBorder"
	| "md.hrChar"
	| "md.bullet"
	| "md.colorSwatch"
	// Advisor
	| "advisor.rail"
	// Language / file type icons
	| "lang.default"
	| "lang.typescript"
	| "lang.javascript"
	| "lang.python"
	| "lang.rust"
	| "lang.go"
	| "lang.java"
	| "lang.c"
	| "lang.cpp"
	| "lang.csharp"
	| "lang.ruby"
	| "lang.julia"
	| "lang.php"
	| "lang.swift"
	| "lang.kotlin"
	| "lang.shell"
	| "lang.html"
	| "lang.css"
	| "lang.json"
	| "lang.yaml"
	| "lang.markdown"
	| "lang.sql"
	| "lang.docker"
	| "lang.lua"
	| "lang.text"
	| "lang.env"
	| "lang.toml"
	| "lang.xml"
	| "lang.ini"
	| "lang.conf"
	| "lang.log"
	| "lang.csv"
	| "lang.tsv"
	| "lang.image"
	| "lang.pdf"
	| "lang.archive"
	| "lang.binary"
	// Settings tab icons
	| "tab.appearance"
	| "tab.model"
	| "tab.interaction"
	| "tab.context"
	| "tab.files"
	| "tab.shell"
	| "tab.tools"
	| "tab.memory"
	| "tab.tasks"
	| "tab.providers"
	// Tool identity icons
	| "tool.write"
	| "tool.edit"
	| "tool.bash"
	| "tool.ssh"
	| "tool.lsp"
	| "tool.gh"
	| "tool.webSearch"
	| "tool.exa"
	| "tool.browser"
	| "tool.eval"
	| "tool.debug"
	| "tool.mcp"
	| "tool.job"
	| "tool.launch"
	| "tool.task"
	| "tool.todo"
	| "tool.memory"
	| "tool.ask"
	| "tool.resolve"
	| "tool.review"
	| "tool.inspectImage"
	| "tool.goal"
	| "tool.irc"
	| "tool.delete"
	| "tool.move";

type SymbolMap = Record<SymbolKey, string>;

// ============================================================================
// Unicode symbols
// ============================================================================

const UNICODE_SYMBOLS: SymbolMap = {
	// Status
	"status.success": "✓",
	"status.error": "✗",
	"status.warning": "⚠",
	"status.info": "ℹ",
	"status.pending": "○",
	"status.disabled": "⊘",
	"status.enabled": "●",
	"status.running": "▶",
	"status.shadowed": "◌",
	"status.aborted": "⊘",
	"status.done": "✓",
	// Navigation
	"nav.cursor": "▸",
	"nav.selected": "●",
	"nav.expand": "▶",
	"nav.collapse": "▼",
	"nav.back": "◀",
	// Tree
	"tree.branch": "├──",
	"tree.last": "└──",
	"tree.vertical": "│",
	"tree.horizontal": "──",
	"tree.hook": "└",
	// Box rounded
	"boxRound.topLeft": "╭",
	"boxRound.topRight": "╮",
	"boxRound.bottomLeft": "╰",
	"boxRound.bottomRight": "╯",
	"boxRound.horizontal": "─",
	"boxRound.vertical": "│",
	// Box sharp
	"boxSharp.topLeft": "┌",
	"boxSharp.topRight": "┐",
	"boxSharp.bottomLeft": "└",
	"boxSharp.bottomRight": "┘",
	"boxSharp.horizontal": "─",
	"boxSharp.vertical": "│",
	"boxSharp.cross": "┼",
	"boxSharp.teeDown": "┬",
	"boxSharp.teeUp": "┴",
	"boxSharp.teeRight": "├",
	"boxSharp.teeLeft": "┤",
	// Separators
	"sep.powerline": "",
	"sep.powerlineThin": "",
	"sep.powerlineLeft": "",
	"sep.powerlineRight": "",
	"sep.powerlineThinLeft": "",
	"sep.powerlineThinRight": "",
	"sep.block": " ",
	"sep.space": " ",
	"sep.asciiLeft": "<",
	"sep.asciiRight": ">",
	"sep.dot": "·",
	"sep.slash": "/",
	"sep.pipe": "|",
	// Icons
	"icon.model": "◆",
	"icon.plan": "📋",
	"icon.prewalk": "🔍",
	"icon.goal": "🎯",
	"icon.pause": "⏸",
	"icon.loop": "🔄",
	"icon.folder": "📁",
	"icon.worktree": "🌿",
	"icon.search": "🔎",
	"icon.scratchFolder": "📂",
	"icon.file": "📄",
	"icon.git": "",
	"icon.branch": "🌱",
	"icon.pr": "🔀",
	"icon.tokens": "🔤",
	"icon.context": "📝",
	"icon.cost": "💰",
	"icon.time": "⏱",
	"icon.pi": "π",
	"icon.ghost": "👻",
	"icon.agents": "🤖",
	"icon.job": "⚡",
	"icon.cache": "💾",
	"icon.cacheMiss": "❌",
	"icon.input": "📥",
	"icon.output": "📤",
	"icon.throughput": "📊",
	"icon.host": "🖥",
	"icon.session": "🔌",
	"icon.package": "📦",
	"icon.warning": "⚠",
	"icon.rewind": "⏪",
	"icon.auto": "⚡",
	"icon.fast": "🚀",
	"icon.extensionSkill": "🧠",
	"icon.extensionTool": "🔧",
	"icon.extensionSlashCommand": "/",
	"icon.extensionMcp": "🔗",
	"icon.extensionRule": "📏",
	"icon.extensionHook": "🪝",
	"icon.extensionPrompt": "💬",
	"icon.extensionContextFile": "📎",
	"icon.extensionInstruction": "📋",
	"icon.mic": "🎤",
	"icon.camera": "📷",
	// Thinking
	"thinking.minimal": "◌",
	"thinking.low": "◔",
	"thinking.medium": "◑",
	"thinking.high": "◕",
	"thinking.xhigh": "●",
	"thinking.max": "◉",
	"thinking.autoPending": "◎",
	// Checkboxes
	"checkbox.checked": "☑",
	"checkbox.unchecked": "☐",
	// Radio
	"radio.selected": "●",
	"radio.unselected": "○",
	// Formatting
	"format.bullet": "•",
	"format.dash": "–",
	"format.bracketLeft": "[",
	"format.bracketRight": "]",
	// Markdown
	"md.quoteBorder": "▍",
	"md.hrChar": "─",
	"md.bullet": "-",
	"md.colorSwatch": "█",
	// Advisor
	"advisor.rail": "▎",
	// Language icons
	"lang.default": "📄",
	"lang.typescript": "",
	"lang.javascript": "",
	"lang.python": "🐍",
	"lang.rust": "🦀",
	"lang.go": "🔷",
	"lang.java": "☕",
	"lang.c": "🔵",
	"lang.cpp": "🔷",
	"lang.csharp": "♯",
	"lang.ruby": "💎",
	"lang.julia": "🔮",
	"lang.php": "🐘",
	"lang.swift": "🐦",
	"lang.kotlin": "🏔",
	"lang.shell": "",
	"lang.html": "🌐",
	"lang.css": "🎨",
	"lang.json": "📋",
	"lang.yaml": "📋",
	"lang.markdown": "📝",
	"lang.sql": "🗄",
	"lang.docker": "🐳",
	"lang.lua": "🌙",
	"lang.text": "📄",
	"lang.env": "🔐",
	"lang.toml": "📋",
	"lang.xml": "📋",
	"lang.ini": "⚙",
	"lang.conf": "⚙",
	"lang.log": "📋",
	"lang.csv": "📊",
	"lang.tsv": "📊",
	"lang.image": "🖼",
	"lang.pdf": "📕",
	"lang.archive": "📦",
	"lang.binary": "🔢",
	// Tab icons
	"tab.appearance": "🎨",
	"tab.model": "🧠",
	"tab.interaction": "💬",
	"tab.context": "📝",
	"tab.files": "📁",
	"tab.shell": "",
	"tab.tools": "🔧",
	"tab.memory": "💾",
	"tab.tasks": "📋",
	"tab.providers": "🔌",
	// Tool identity icons
	"tool.write": "✏",
	"tool.edit": "📝",
	"tool.bash": "$",
	"tool.ssh": "🔐",
	"tool.lsp": "◇",
	"tool.gh": "🐙",
	"tool.webSearch": "🔍",
	"tool.exa": "🔎",
	"tool.browser": "🌐",
	"tool.eval": "▶",
	"tool.debug": "🐛",
	"tool.mcp": "🔗",
	"tool.job": "⚡",
	"tool.launch": "🚀",
	"tool.task": "📋",
	"tool.todo": "☑",
	"tool.memory": "🧠",
	"tool.ask": "❓",
	"tool.resolve": "✅",
	"tool.review": "👁",
	"tool.inspectImage": "🖼",
	"tool.goal": "🎯",
	"tool.irc": "📡",
	"tool.delete": "🗑",
	"tool.move": "↗",
};

// ============================================================================
// ASCII fallback symbols
// ============================================================================

const ASCII_SYMBOLS: SymbolMap = {
	"status.success": "+",
	"status.error": "x",
	"status.warning": "!",
	"status.info": "i",
	"status.pending": "o",
	"status.disabled": "%",
	"status.enabled": "@",
	"status.running": ">",
	"status.shadowed": " ",
	"status.aborted": "%",
	"status.done": "+",
	"nav.cursor": ">",
	"nav.selected": "o",
	"nav.expand": "v",
	"nav.collapse": "<",
	"nav.back": "<",
	"tree.branch": "|--",
	"tree.last": "`--",
	"tree.vertical": "|",
	"tree.horizontal": "--",
	"tree.hook": "`",
	"boxRound.topLeft": ".",
	"boxRound.topRight": ".",
	"boxRound.bottomLeft": "'",
	"boxRound.bottomRight": "'",
	"boxRound.horizontal": "-",
	"boxRound.vertical": "|",
	"boxSharp.topLeft": ".",
	"boxSharp.topRight": ".",
	"boxSharp.bottomLeft": "'",
	"boxSharp.bottomRight": "'",
	"boxSharp.horizontal": "-",
	"boxSharp.vertical": "|",
	"boxSharp.cross": "+",
	"boxSharp.teeDown": "v",
	"boxSharp.teeUp": "^",
	"boxSharp.teeRight": "<",
	"boxSharp.teeLeft": ">",
	"sep.powerline": "",
	"sep.powerlineThin": "",
	"sep.powerlineLeft": "",
	"sep.powerlineRight": "",
	"sep.powerlineThinLeft": "",
	"sep.powerlineThinRight": "",
	"sep.block": " ",
	"sep.space": " ",
	"sep.asciiLeft": "<",
	"sep.asciiRight": ">",
	"sep.dot": ".",
	"sep.slash": "/",
	"sep.pipe": "|",
	"icon.model": "#",
	"icon.plan": "*",
	"icon.prewalk": "?",
	"icon.goal": "*",
	"icon.pause": "=",
	"icon.loop": "~",
	"icon.folder": "[+]",
	"icon.worktree": "*",
	"icon.search": "?",
	"icon.scratchFolder": "[-]",
	"icon.file": "f",
	"icon.git": "g",
	"icon.branch": "b",
	"icon.pr": "m",
	"icon.tokens": "T",
	"icon.context": "C",
	"icon.cost": "$",
	"icon.time": "t",
	"icon.pi": "p",
	"icon.ghost": "?",
	"icon.agents": "A",
	"icon.job": "!",
	"icon.cache": "H",
	"icon.cacheMiss": "M",
	"icon.input": "<",
	"icon.output": ">",
	"icon.throughput": "~",
	"icon.host": "H",
	"icon.session": "S",
	"icon.package": "P",
	"icon.warning": "!",
	"icon.rewind": "<",
	"icon.auto": "A",
	"icon.fast": "F",
	"icon.extensionSkill": "S",
	"icon.extensionTool": "T",
	"icon.extensionSlashCommand": "/",
	"icon.extensionMcp": "M",
	"icon.extensionRule": "R",
	"icon.extensionHook": "H",
	"icon.extensionPrompt": "P",
	"icon.extensionContextFile": "F",
	"icon.extensionInstruction": "I",
	"icon.mic": "(",
	"icon.camera": "*",
	"thinking.minimal": " ",
	"thinking.low": "o",
	"thinking.medium": "O",
	"thinking.high": "@",
	"thinking.xhigh": "#",
	"thinking.max": "@",
	"thinking.autoPending": "?",
	"checkbox.checked": "[x]",
	"checkbox.unchecked": "[ ]",
	"radio.selected": "(x)",
	"radio.unselected": "( )",
	"format.bullet": "*",
	"format.dash": "-",
	"format.bracketLeft": "[",
	"format.bracketRight": "]",
	"md.quoteBorder": "|",
	"md.hrChar": "-",
	"md.bullet": "-",
	"md.colorSwatch": "#",
	"advisor.rail": "|",
	"lang.default": "?",
	"lang.typescript": "TS",
	"lang.javascript": "JS",
	"lang.python": "PY",
	"lang.rust": "RS",
	"lang.go": "GO",
	"lang.java": "JV",
	"lang.c": "C",
	"lang.cpp": "CPP",
	"lang.csharp": "CS",
	"lang.ruby": "RB",
	"lang.julia": "JL",
	"lang.php": "PHP",
	"lang.swift": "SW",
	"lang.kotlin": "KT",
	"lang.shell": "SH",
	"lang.html": "HT",
	"lang.css": "CSS",
	"lang.json": "JSON",
	"lang.yaml": "YML",
	"lang.markdown": "MD",
	"lang.sql": "SQL",
	"lang.docker": "DK",
	"lang.lua": "LUA",
	"lang.text": "TXT",
	"lang.env": "ENV",
	"lang.toml": "TOML",
	"lang.xml": "XML",
	"lang.ini": "INI",
	"lang.conf": "CFG",
	"lang.log": "LOG",
	"lang.csv": "CSV",
	"lang.tsv": "TSV",
	"lang.image": "IMG",
	"lang.pdf": "PDF",
	"lang.archive": "ARC",
	"lang.binary": "BIN",
	"tab.appearance": "A",
	"tab.model": "M",
	"tab.interaction": "I",
	"tab.context": "C",
	"tab.files": "F",
	"tab.shell": "$",
	"tab.tools": "T",
	"tab.memory": "M",
	"tab.tasks": "T",
	"tab.providers": "P",
	"tool.write": "w",
	"tool.edit": "e",
	"tool.bash": "$",
	"tool.ssh": "s",
	"tool.lsp": "L",
	"tool.gh": "g",
	"tool.webSearch": "?",
	"tool.exa": "?",
	"tool.browser": "B",
	"tool.eval": ">",
	"tool.debug": "d",
	"tool.mcp": "m",
	"tool.job": "j",
	"tool.launch": ">",
	"tool.task": "t",
	"tool.todo": "x",
	"tool.memory": "M",
	"tool.ask": "?",
	"tool.resolve": "+",
	"tool.review": "R",
	"tool.inspectImage": "I",
	"tool.goal": "G",
	"tool.irc": "~",
	"tool.delete": "X",
	"tool.move": ">",
};

// ============================================================================
// Preset registry
// ============================================================================

const SYMBOL_PRESETS: Record<SymbolPreset, SymbolMap> = {
	unicode: UNICODE_SYMBOLS,
	ascii: ASCII_SYMBOLS,
};

// ============================================================================
// Runtime state
// ============================================================================

let globalSymbolPreset: SymbolPreset = "unicode";

export function setSymbolPreset(preset: SymbolPreset): void {
	globalSymbolPreset = preset;
}

export function getSymbolPreset(): SymbolPreset {
	return globalSymbolPreset;
}

/** Get a single symbol string for the active preset. */
export function getSymbol(key: SymbolKey): string {
	return SYMBOL_PRESETS[globalSymbolPreset][key];
}

/** Get spinner frames for the active preset. */
export function getSpinnerFrames(): string[] {
	if (globalSymbolPreset === "ascii") return ["|", "/", "-", "\\"];
	return ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
}

// ============================================================================
// Language icon mapping
// ============================================================================

/** Extension → language icon key. */
export const LANG_MAP: Record<string, SymbolKey> = {
	ts: "lang.typescript",
	tsx: "lang.typescript",
	js: "lang.javascript",
	jsx: "lang.javascript",
	mjs: "lang.javascript",
	cjs: "lang.javascript",
	py: "lang.python",
	rs: "lang.rust",
	go: "lang.go",
	java: "lang.java",
	c: "lang.c",
	cpp: "lang.cpp",
	"c++": "lang.cpp",
	cc: "lang.cpp",
	cxx: "lang.cpp",
	cs: "lang.csharp",
	csharp: "lang.csharp",
	rb: "lang.ruby",
	julia: "lang.julia",
	jl: "lang.julia",
	php: "lang.php",
	swift: "lang.swift",
	kt: "lang.kotlin",
	bash: "lang.shell",
	sh: "lang.shell",
	zsh: "lang.shell",
	fish: "lang.shell",
	shell: "lang.shell",
	html: "lang.html",
	htm: "lang.html",
	css: "lang.css",
	scss: "lang.css",
	sass: "lang.css",
	json: "lang.json",
	yaml: "lang.yaml",
	yml: "lang.yaml",
	md: "lang.markdown",
	sql: "lang.sql",
	dockerfile: "lang.docker",
	lua: "lang.lua",
	text: "lang.text",
	txt: "lang.text",
	env: "lang.env",
	toml: "lang.toml",
	xml: "lang.xml",
	ini: "lang.ini",
	conf: "lang.conf",
	cfg: "lang.conf",
	log: "lang.log",
	csv: "lang.csv",
	tsv: "lang.tsv",
	png: "lang.image",
	jpg: "lang.image",
	jpeg: "lang.image",
	gif: "lang.image",
	webp: "lang.image",
	svg: "lang.image",
	ico: "lang.image",
	bmp: "lang.image",
	pdf: "lang.pdf",
	zip: "lang.archive",
	tar: "lang.archive",
	gz: "lang.archive",
	tgz: "lang.archive",
	bz2: "lang.archive",
	xz: "lang.archive",
	"7z": "lang.archive",
	exe: "lang.binary",
	dll: "lang.binary",
	so: "lang.binary",
	wasm: "lang.binary",
};

/** Brand colors for language icons, keyed by SymbolKey. */
export const LANG_BRAND_COLORS: Partial<Record<SymbolKey, string>> = {
	"lang.typescript": "#3178c6",
	"lang.javascript": "#f7df1e",
	"lang.python": "#3776ab",
	"lang.rust": "#dea584",
	"lang.go": "#00add8",
	"lang.java": "#b07219",
	"lang.c": "#555555",
	"lang.cpp": "#f34b7d",
	"lang.csharp": "#178600",
	"lang.ruby": "#701516",
	"lang.julia": "#9558b2",
	"lang.php": "#777bb4",
	"lang.swift": "#f05138",
	"lang.kotlin": "#a97bff",
	"lang.shell": "#89e051",
	"lang.html": "#e34c26",
	"lang.css": "#563d7c",
	"lang.json": "#292929",
	"lang.yaml": "#cb171e",
	"lang.markdown": "#083fa1",
	"lang.sql": "#e38c00",
	"lang.docker": "#384d54",
	"lang.lua": "#000080",
};

const LANG_DEFAULT_KEY: SymbolKey = "lang.default";

/** Get the language icon key for a file extension. */
export function getLangIconKey(ext: string): SymbolKey {
	return LANG_MAP[ext.toLowerCase()] ?? LANG_DEFAULT_KEY;
}

// ============================================================================
// SymbolTheme — optionally colored with a Theme
// ============================================================================

/** SymbolTheme with optional Theme-based ANSI coloring. */
export interface SymbolTheme {
	spinnerFrames: string[];
	/** Get a raw symbol character for the active preset. */
	symbol: (key: SymbolKey) => string;
	/** Get a language icon character for a file extension. */
	langIcon: (ext: string) => string;
	/** Get the brand hex color for a language extension. */
	langBrandColor: (ext: string) => string | undefined;
	/**
	 * Get a colored symbol: wraps the symbol with theme.fg(color, symbol).
	 * When theme is null, returns the raw symbol string.
	 */
	symbolFg: (key: SymbolKey, color: string, theme?: Theme | null) => string;
}

/**
 * Build the symbol theme for the active preset.
 * When `theme` is provided, returned ANSI strings are colorable.
 */
export function getSymbolTheme(): SymbolTheme {
	const map = SYMBOL_PRESETS[globalSymbolPreset];

	return {
		spinnerFrames: getSpinnerFrames(),
		symbol: (key) => map[key],
		langIcon: (ext) => map[getLangIconKey(ext)],
		langBrandColor: (ext) => LANG_BRAND_COLORS[getLangIconKey(ext)],
		symbolFg: (key, color, th) => {
			const sym = map[key];
			return th ? th.fg(color as any, sym) : sym;
		},
	};
}
