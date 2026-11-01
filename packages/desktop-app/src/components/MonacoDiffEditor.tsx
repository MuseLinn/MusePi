import { t } from "@musepi/client-core";
import { diffLayoutPref } from "@musepi/client-core/src/tool-render/parts-shared";
import type * as Monaco from "monaco-editor";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { loadMonaco, observeMonacoTheme } from "../lib/monaco-runtime";
import { Icon } from "../vendor/oc-icons";

export interface MonacoDiffContent {
	original: string;
	modified: string;
}

interface MonacoDiffEditorProps extends MonacoDiffContent {
	path: string;
	scope: "staged" | "unstaged";
	fallback: ReactNode;
}

/** Read-only Monaco diff for the existing changes tree. The parent owns Git
 * versions and the patch fallback; this component owns only diff view state. */
export function MonacoDiffEditor({ path, scope, original, modified, fallback }: MonacoDiffEditorProps): ReactNode {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const editorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null);
	const [failed, setFailed] = useState(false);
	const [ready, setReady] = useState(false);
	const [changeCount, setChangeCount] = useState(0);
	const [changeIndex, setChangeIndex] = useState(0);
	const layout = diffLayoutPref();

	useEffect(() => {
		let cancelled = false;
		let observer: MutationObserver | null = null;
		setReady(false);
		setFailed(false);
		void loadMonaco()
			.then(monaco => {
				const container = containerRef.current;
				if (cancelled || !container) return;
				const uri = monaco.Uri.file(path);
				const originalModel = monaco.editor.createModel(
					original,
					undefined,
					uri.with({ query: `${scope}-original` }),
				);
				const modifiedModel = monaco.editor.createModel(
					modified,
					undefined,
					uri.with({ query: `${scope}-modified` }),
				);
				const editor = monaco.editor.createDiffEditor(container, {
					automaticLayout: true,
					diffAlgorithm: "advanced",
					diffWordWrap: "on",
					fixedOverflowWidgets: true,
					fontFamily: getComputedStyle(container).getPropertyValue("--font-mono").trim() || "monospace",
					fontSize: 11,
					hideUnchangedRegions: { enabled: true, minimumLineCount: 4, contextLineCount: 3 },
					lineHeight: 18,
					minimap: { enabled: false },
					modifiedAriaLabel: path,
					originalAriaLabel: path,
					originalEditable: false,
					readOnly: true,
					renderOverviewRuler: true,
					renderSideBySide: layout !== "inline",
					renderSideBySideInlineBreakpoint: 720,
					scrollBeyondLastLine: false,
					stickyScroll: { enabled: false },
					useInlineViewWhenSpaceIsLimited: layout === "dynamic",
				});
				editorRef.current = editor;
				editor.setModel({ original: originalModel, modified: modifiedModel });
				editor.onDidUpdateDiff(() => {
					setChangeCount(editor.getLineChanges()?.length ?? 0);
					setChangeIndex(0);
				});
				observer = observeMonacoTheme(monaco);
				setReady(true);
			})
			.catch(() => {
				if (!cancelled) setFailed(true);
			});
		return () => {
			cancelled = true;
			observer?.disconnect();
			const editor = editorRef.current;
			editorRef.current = null;
			const models = editor?.getModel();
			editor?.dispose();
			models?.original.dispose();
			models?.modified.dispose();
		};
	}, [path, scope, original, modified, layout]);

	if (failed) return <>{fallback}</>;
	const goTo = (target: "next" | "previous"): void => {
		if (changeCount === 0) return;
		editorRef.current?.goToDiff(target);
		setChangeIndex(current => (current + (target === "next" ? 1 : -1) + changeCount) % changeCount);
	};
	const label = t(scope === "staged" ? "general.staged" : "general.unstaged");
	return (
		<section className="gui-monaco-diff" aria-label={label}>
			<div className="gui-monaco-diff-toolbar">
				<span className="gui-changes-diff-kind">{label}</span>
				<span className="gui-monaco-diff-position" aria-live="polite">
					{changeCount > 0 ? `${changeIndex + 1} / ${changeCount}` : "0"}
				</span>
				<button
					type="button"
					className="gui-btn gui-btn-icon"
					title={t("general.previousChange")}
					aria-label={t("general.previousChange")}
					disabled={!ready || changeCount === 0}
					onClick={() => goTo("previous")}
				>
					<Icon name="arrow-up" className="h-3 w-3" />
				</button>
				<button
					type="button"
					className="gui-btn gui-btn-icon"
					title={t("general.nextChange")}
					aria-label={t("general.nextChange")}
					disabled={!ready || changeCount === 0}
					onClick={() => goTo("next")}
				>
					<Icon name="arrow-down" className="h-3 w-3" />
				</button>
			</div>
			<div
				ref={containerRef}
				className="gui-monaco-diff-editor"
				data-ready={ready || undefined}
				data-diff-count={changeCount}
				data-change-index={changeIndex}
			/>
		</section>
	);
}
