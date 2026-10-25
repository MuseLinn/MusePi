import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { $ } from "bun";

const STATUSES = new Set(["living", "reference", "draft", "archived"]);
const REQUIRED_METADATA = new Set([
	"docs/assembly.md",
	"docs/assembly.zh-CN.md",
	"docs/documentation.md",
	"docs/documentation.zh-CN.md",
	"docs/extensions-dev.md",
	"docs/extensions-dev.zh-CN.md",
	"docs/gui-design.md",
	"docs/gui-design.zh-CN.md",
	"docs/gui-implementation.md",
	"docs/gui-implementation.zh-CN.md",
	"docs/i18n.md",
	"docs/i18n.zh-CN.md",
	"docs/index.md",
	"docs/index.zh-CN.md",
	"docs/mobile-design.md",
	"docs/models.md",
	"docs/models.zh-CN.md",
	"docs/naming.md",
	"docs/naming.zh-CN.md",
	"docs/session.md",
	"docs/session.zh-CN.md",
	"docs/settings.md",
	"docs/settings.zh-CN.md",
]);

interface DocumentMetadata {
	title: string;
	status: string;
	summary: string;
	scope: string[];
}

function parseMetadata(frontmatter: string): DocumentMetadata | null {
	const value: DocumentMetadata = { title: "", status: "", summary: "", scope: [] };
	let inScope = false;
	for (const line of frontmatter.split(/\r?\n/)) {
		const field = line.match(/^(title|status|summary|scope):\s*(.*)$/);
		if (field) {
			inScope = field[1] === "scope";
			if (!inScope) value[field[1]] = field[2].trim().replace(/^(['"])(.*)\1$/, "$2");
			continue;
		}
		const item = line.match(/^\s+-\s+(.+)$/);
		if (inScope && item) value.scope.push(item[1].trim());
		else if (line.trim()) inScope = false;
	}
	return value;
}

function metadataErrors(source: string): string[] {
	if (!source.startsWith("---\n") && !source.startsWith("---\r\n")) return ["missing frontmatter"];
	const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
	if (!match) return ["unterminated frontmatter"];
	const value = parseMetadata(match[1]);
	if (!value) return ["frontmatter must be a mapping"];
	const errors: string[] = [];
	if (!value.title) errors.push("title must be a non-empty string");
	if (!STATUSES.has(value.status)) errors.push("status must be living, reference, draft, or archived");
	if (!value.summary) errors.push("summary must be a non-empty string");
	if (value.scope.length === 0) errors.push("scope must list at least one owning path");
	return errors;
}

async function markdownFiles(directory: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await markdownFiles(path)));
		else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
	}
	return files;
}

const rootFlag = process.argv.indexOf("--root");
const root = resolve(rootFlag >= 0 ? process.argv[rootFlag + 1] : resolve(import.meta.dir, ".."));
const result = await $`git -C ${root} ls-tree -r --name-only HEAD -- docs`.quiet().nothrow();
const existingAtHead = new Set(result.exitCode === 0 ? result.text().split(/\r?\n/).filter(Boolean) : []);
const failures: string[] = [];
const PROCESS_RECORD_PREFIXES = [
	"docs/archive/",
	"docs/adr/",
	"docs/gui-verification/",
	"docs/review/",
	"docs/superpowers/",
];

for (const file of await markdownFiles(join(root, "docs"))) {
	const path = relative(root, file).replaceAll("\\", "/");
	if (PROCESS_RECORD_PREFIXES.some(prefix => path.startsWith(prefix))) continue;
	if (existingAtHead.has(path) && !REQUIRED_METADATA.has(path)) continue;
	const source = await Bun.file(file).text();
	for (const error of metadataErrors(source)) failures.push(`${path}: ${error}`);
}

if (failures.length > 0) {
	for (const failure of failures) console.error(failure);
	process.exit(1);
}
