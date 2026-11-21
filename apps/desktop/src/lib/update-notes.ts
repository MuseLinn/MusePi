/**
 * Release notes from update-manifest.json are the newest CHANGELOG.musepi
 * section as one bilingual string: a Chinese bullet followed by an indented
 * `  - EN:` child, filed under the canonical `### 新功能/改进/修复` headings
 * and prefixed by the `本次发布：…` counts line. The daemon localizes the
 * what's-new payload; the OTA manifest has no locale field, so the renderer
 * picks one language here.
 * Mirrors coding-agent/src/utils/changelog.ts `localizeChangelogContent`.
 */
import {
	localizeReleaseHeading,
	localizeReleaseSummary,
	releaseSummaryPrefix,
} from "@musepi/client-core/src/i18n/release-notes";

export function localizeUpdateNotes(markdown: string, locale: string): string {
	const english = locale.toLowerCase().startsWith("en");
	const summaryPrefix = releaseSummaryPrefix("zh-CN");
	const lines = markdown.split("\n");
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (/^\s*- EN: /.test(line)) continue;
		if (english) {
			const heading = line.match(/^###\s+(.+?)\s*$/);
			const translated = heading ? localizeReleaseHeading(heading[1], locale) : undefined;
			if (translated) {
				out.push(`### ${translated}`);
				continue;
			}
			if (line.startsWith(summaryPrefix)) {
				out.push(localizeReleaseSummary(line.slice(summaryPrefix.length), locale));
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
