import { t } from "@musepi/client-core";
import { Fragment, type ReactNode } from "react";
import type { MetadataEntry } from "../../lib/markdown-frontmatter";

/** Read-only front matter block. One card serves the file preview and the
 *  WYSIWYG editor: the editor keeps the YAML out of Crepe's document so it is
 *  never re-serialized, and this is what the user sees in its place. */
export function MarkdownMetadata({ raw, entries }: { raw: string; entries: MetadataEntry[] }): ReactNode {
	if (!raw) return null;
	return (
		<section className="gui-md-meta" aria-label={t("markdownMetadata")}>
			<div className="gui-md-meta-head">{t("markdownMetadata")}</div>
			{entries.length > 0 ? (
				<dl className="gui-md-meta-grid">
					{entries.map(entry => (
						<Fragment key={entry.key}>
							<dt>{entry.key}</dt>
							<dd>
								{entry.values.map((value, index) => (
									<span key={`${entry.key}-${index}`}>{value}</span>
								))}
							</dd>
						</Fragment>
					))}
				</dl>
			) : (
				<pre className="gui-md-meta-raw">{raw.trim()}</pre>
			)}
		</section>
	);
}
