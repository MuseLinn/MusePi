/**
 * Release notes from update-manifest.json are the newest CHANGELOG.musepi
 * section as one bilingual string: a Chinese bullet followed by an indented
 * `  - EN:` child, filed under the canonical `### 新功能/改进/修复` headings
 * and prefixed by the `本次发布：…` counts line. The daemon localizes the
 * what's-new payload; the OTA manifest has no locale field, so the renderer
 * picks one language here.
 * Mirrors coding-agent/src/utils/changelog.ts `localizeChangelogContent`.
 */

const ENGLISH_CATEGORY_HEADING: Record<string, string> = {
	新功能: "New features",
	改进: "Improvements",
	修复: "Fixes",
};

const SUMMARY_CATEGORY_LABELS: Record<string, readonly [one: string, many: string]> = {
	新功能: ["new feature", "new features"],
	改进: ["improvement", "improvements"],
	修复: ["fix", "fixes"],
	其他变更: ["other change", "other changes"],
};

const RELEASE_SUMMARY_PREFIX = "本次发布：";

/** Translate `本次发布：2 项新功能 · 1 项改进 · 1 项修复` and keep any
 *  unrecognized segment verbatim instead of dropping the breakdown. */
function localizeReleaseSummary(summary: string): string {
	if (summary.trim() === "无用户可见变更") return "This release: no user-visible changes";
	const parts = summary.split(" · ").map(item => {
		const match = item.match(/^(\d+)\s*项(新功能|改进|修复|其他变更)$/);
		if (!match) return item;
		const count = Number(match[1]);
		const labels = SUMMARY_CATEGORY_LABELS[match[2] ?? ""];
		if (!labels) return item;
		return `${count} ${count === 1 ? labels[0] : labels[1]}`;
	});
	return `This release: ${parts.join(" · ")}`;
}

export function localizeUpdateNotes(markdown: string, locale: string): string {
	const english = locale.toLowerCase().startsWith("en");
	const lines = markdown.split("\n");
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (/^\s*- EN: /.test(line)) continue;
		if (english) {
			const heading = line.match(/^###\s+(.+?)\s*$/);
			const translated = heading ? ENGLISH_CATEGORY_HEADING[heading[1]] : undefined;
			if (translated) {
				out.push(`### ${translated}`);
				continue;
			}
			if (line.startsWith(RELEASE_SUMMARY_PREFIX)) {
				out.push(localizeReleaseSummary(line.slice(RELEASE_SUMMARY_PREFIX.length)));
				continue;
			}
		}
		if (english && /^-\s+\S/.test(line)) {
			// Multi-line entries put the `- EN:` child after their
			// continuation block — scan forward until the next bullet.
			let j = i + 1;
			let enLine: string | undefined;
			while (j < lines.length && !/^-\s/.test(lines[j] ?? "")) {
				const match = (lines[j] ?? "").match(/^\s*- EN: (.*)$/);
				if (match) {
					enLine = match[1] ?? "";
					break;
				}
				j++;
			}
			if (enLine !== undefined) {
				out.push(`- ${enLine}`);
				i = j;
				continue;
			}
		}
		out.push(line);
	}
	return out.join("\n");
}
