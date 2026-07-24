// ============================================================
// MusePi LSP — built-in language server table.
//
// Subset of OMP's defaults.json focused on the common servers. A server
// becomes available only when BOTH conditions hold for the session cwd:
//   1. at least one of its rootMarkers exists (project speaks this language)
//   2. its binary resolves (node_modules/.bin → venv dirs → $PATH)
// Users extend or override via musepi.lsp.servers.
// ============================================================

import type { LspServerConfig } from "./types.ts";

export const BUILTIN_LSP_SERVERS: Record<string, LspServerConfig> = {
	"typescript-language-server": {
		command: "typescript-language-server",
		args: ["--stdio"],
		fileTypes: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
		rootMarkers: ["package.json", "tsconfig.json", "jsconfig.json"],
		initOptions: {
			hostInfo: "musepi",
			preferences: {
				includeInlayParameterNameHints: "none",
			},
		},
	},
	pyright: {
		command: "pyright-langserver",
		args: ["--stdio"],
		fileTypes: [".py", ".pyi"],
		rootMarkers: ["pyproject.toml", "pyrightconfig.json", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"],
		settings: {
			python: {
				analysis: {
					autoSearchPaths: true,
					diagnosticMode: "openFilesOnly",
					useLibraryCodeForTypes: true,
				},
			},
		},
	},
	basedpyright: {
		command: "basedpyright-langserver",
		args: ["--stdio"],
		fileTypes: [".py", ".pyi"],
		rootMarkers: ["pyproject.toml", "pyrightconfig.json", "setup.py", "requirements.txt"],
		settings: {
			basedpyright: {
				analysis: {
					autoSearchPaths: true,
					diagnosticMode: "openFilesOnly",
					useLibraryCodeForTypes: true,
				},
			},
		},
	},
	pylsp: {
		command: "pylsp",
		args: [],
		fileTypes: [".py"],
		rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"],
	},
	ruff: {
		command: "ruff",
		args: ["server"],
		fileTypes: [".py", ".pyi"],
		rootMarkers: ["pyproject.toml", "ruff.toml", ".ruff.toml"],
		isLinter: true,
	},
	gopls: {
		command: "gopls",
		args: ["serve"],
		fileTypes: [".go", ".mod", ".sum"],
		rootMarkers: ["go.mod", "go.work", "go.sum"],
		settings: {
			gopls: {
				staticcheck: true,
			},
		},
	},
	"rust-analyzer": {
		command: "rust-analyzer",
		args: [],
		fileTypes: [".rs"],
		rootMarkers: ["Cargo.toml", "rust-analyzer.toml"],
		settings: {
			"rust-analyzer": {
				checkOnSave: false,
			},
		},
	},
	clangd: {
		command: "clangd",
		args: ["--background-index", "--clang-tidy", "--header-insertion=iwyu"],
		fileTypes: [".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx"],
		rootMarkers: ["compile_commands.json", "CMakeLists.txt", ".clangd", ".clang-format", "Makefile"],
	},
	zls: {
		command: "zls",
		args: [],
		fileTypes: [".zig"],
		rootMarkers: ["build.zig", "build.zig.zon", "zls.json"],
	},
	biome: {
		command: "biome",
		args: ["lsp-proxy"],
		fileTypes: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc"],
		rootMarkers: ["biome.json", "biome.jsonc"],
		isLinter: true,
	},
	denols: {
		command: "deno",
		args: ["lsp"],
		fileTypes: [".ts", ".tsx", ".js", ".jsx"],
		rootMarkers: ["deno.json", "deno.jsonc", "deno.lock"],
		initOptions: {
			enable: true,
			lint: true,
			unstable: true,
		},
	},
	"vscode-html-language-server": {
		command: "vscode-html-language-server",
		args: ["--stdio"],
		fileTypes: [".html", ".htm"],
		rootMarkers: ["package.json", ".git"],
		initOptions: { provideFormatter: true },
	},
	"vscode-css-language-server": {
		command: "vscode-css-language-server",
		args: ["--stdio"],
		fileTypes: [".css", ".scss", ".sass", ".less"],
		rootMarkers: ["package.json", ".git"],
		initOptions: { provideFormatter: true },
	},
	"vscode-json-language-server": {
		command: "vscode-json-language-server",
		args: ["--stdio"],
		fileTypes: [".json", ".jsonc"],
		rootMarkers: ["package.json", ".git"],
		initOptions: { provideFormatter: true },
	},
	svelte: {
		command: "svelteserver",
		args: ["--stdio"],
		fileTypes: [".svelte"],
		rootMarkers: ["svelte.config.js", "svelte.config.mjs", "package.json"],
	},
	"vue-language-server": {
		command: "vue-language-server",
		args: ["--stdio"],
		fileTypes: [".vue"],
		rootMarkers: ["vue.config.js", "nuxt.config.js", "nuxt.config.ts", "package.json"],
	},
	bashls: {
		command: "bash-language-server",
		args: ["start"],
		fileTypes: [".sh", ".bash", ".zsh"],
		rootMarkers: [".git"],
	},
	"lua-language-server": {
		command: "lua-language-server",
		args: [],
		fileTypes: [".lua"],
		rootMarkers: [".luarc.json", ".luarc.jsonc", ".luacheckrc", ".stylua.toml", "stylua.toml"],
		settings: {
			Lua: {
				runtime: { version: "LuaJIT" },
				workspace: { checkThirdParty: false },
				telemetry: { enable: false },
			},
		},
	},
	"ruby-lsp": {
		command: "ruby-lsp",
		args: [],
		fileTypes: [".rb", ".rake", ".gemspec", ".erb"],
		rootMarkers: ["Gemfile", ".ruby-version", ".ruby-gemset"],
		initOptions: { formatter: "auto" },
	},
	jdtls: {
		command: "jdtls",
		args: [],
		fileTypes: [".java"],
		rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", ".project"],
	},
	yamlls: {
		command: "yaml-language-server",
		args: ["--stdio"],
		fileTypes: [".yaml", ".yml"],
		rootMarkers: [".git"],
		settings: {
			yaml: { validate: true, hover: true, completion: true },
			redhat: { telemetry: { enabled: false } },
		},
	},
	marksman: {
		command: "marksman",
		args: ["server"],
		fileTypes: [".md", ".markdown"],
		rootMarkers: [".marksman.toml", ".git"],
	},
	nixd: {
		command: "nixd",
		args: [],
		fileTypes: [".nix"],
		rootMarkers: ["flake.nix", "default.nix", "shell.nix"],
	},
	omnisharp: {
		command: "omnisharp",
		args: ["-z", "--encoding", "utf-8", "--languageserver"],
		fileTypes: [".cs", ".csx"],
		rootMarkers: ["*.sln", "*.csproj", "omnisharp.json", ".git"],
	},
	"sourcekit-lsp": {
		command: "sourcekit-lsp",
		args: [],
		fileTypes: [".swift"],
		rootMarkers: ["Package.swift", "*.xcodeproj", "*.xcworkspace", "project.yml", ".swiftpm"],
	},
	dartls: {
		command: "dart",
		args: ["language-server", "--protocol=lsp"],
		fileTypes: [".dart"],
		rootMarkers: ["pubspec.yaml", "pubspec.lock"],
	},
};
