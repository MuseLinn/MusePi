export const MAX_SESSION_ARTIFACT_PREVIEW_BYTES = 8 * 1024 * 1024;

export interface SessionArtifactPreview {
	text: string;
	truncated: boolean;
	totalBytes: number;
}

export async function readSessionArtifactPreview(
	filePath: string,
	maxBytes: number = MAX_SESSION_ARTIFACT_PREVIEW_BYTES,
): Promise<SessionArtifactPreview> {
	const file = Bun.file(filePath);
	const { size } = await file.stat();
	return {
		text: await file.slice(0, maxBytes).text(),
		truncated: size > maxBytes,
		totalBytes: size,
	};
}
