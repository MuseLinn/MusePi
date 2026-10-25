import type { DisplayContext } from "../messages/display-context";
import { createBrowserAnnotationContext } from "../messages/display-context";
import type { AnnotationPayload } from "./contract";
import { formatAnnotationPrompt } from "./prompt";

/** Annotation results stay out of the textarea: the composer stages their
 * display context and derives the model prompt only when sending. */
export const ANNOTATION_ATTACH_EVENT = "musepi-gui-attach-annotation";

export interface AnnotationAttachDetail {
	readonly text: string;
	readonly displayContext: Extract<DisplayContext, { kind: "browser-annotation" }>;
	readonly image?: File;
}

export function dispatchAnnotationAttach(detail: AnnotationAttachDetail): void {
	window.dispatchEvent(new CustomEvent<AnnotationAttachDetail>(ANNOTATION_ATTACH_EVENT, { detail }));
}

function readDataUrl(file: File): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const reader = new FileReader();
	reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
	reader.onerror = () => reject(reader.error);
	reader.readAsDataURL(file);
	return promise;
}

export async function dispatchAnnotationResult({
	payload,
	screenshot,
	intro,
}: {
	payload: AnnotationPayload;
	screenshot: File | null;
	intro: string;
}): Promise<void> {
	const prompt = formatAnnotationPrompt({ payload, screenshotAttached: screenshot !== null, intro });
	const image = screenshot ? await readDataUrl(screenshot).catch(() => undefined) : undefined;
	dispatchAnnotationAttach({
		text: prompt,
		displayContext: createBrowserAnnotationContext({ payload, prompt, image }),
		...(screenshot ? { image: screenshot } : {}),
	});
}
