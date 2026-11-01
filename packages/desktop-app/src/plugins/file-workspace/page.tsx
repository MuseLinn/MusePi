import type { ReactNode } from "react";
import { filePreviewPathEquals } from "../../lib/file-workspace";
import { revealEditorLocation } from "../../lib/monaco-lsp";
import type { SlotComponentProps } from "../../lib/slot-host";
import { FilePane } from "./FilePane";

/** Adapter between the generic panel-tab seat and the file workspace contract. */
export default function FileWorkspacePage({ rpc, cwd, panelTab, fileWorkspace }: SlotComponentProps): ReactNode {
	if (!rpc || !cwd || !panelTab || !fileWorkspace) return null;
	const workspace = fileWorkspace;
	const openRequest =
		workspace.openRequest &&
		panelTab.target &&
		filePreviewPathEquals(cwd, workspace.openRequest.path, panelTab.target)
			? workspace.openRequest
			: null;
	return (
		<FilePane
			key={panelTab.id}
			rpc={rpc}
			cwd={cwd}
			bufferStore={workspace.buffers}
			activeFile={panelTab.target}
			browseRoot={panelTab.dedupeKey != null ? panelTab.target : null}
			openRequest={openRequest}
			onOpenFile={workspace.openFile}
			onDirty={workspace.setDirty}
			onClosePreview={() => workspace.closeTab(panelTab.id)}
			onNewSession={workspace.onNewSession}
			canNavigateBack={workspace.canNavigateBack}
			canNavigateForward={workspace.canNavigateForward}
			onNavigateBack={() => {
				const location = workspace.navigateHistory("back");
				if (location) revealEditorLocation(location);
			}}
			onNavigateForward={() => {
				const location = workspace.navigateHistory("forward");
				if (location) revealEditorLocation(location);
			}}
			onEditorNavigate={(source, target) => {
				workspace.onEditorNavigate(source, target);
				revealEditorLocation(target);
			}}
			onEditorPositionChange={workspace.onEditorPositionChange}
		/>
	);
}
