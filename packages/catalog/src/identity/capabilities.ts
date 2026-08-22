import { isKimiK3ModelId } from "./family";

/**
 * Model capability vocabulary projected from a model's input modalities plus
 * id-family knowledge. Consumed by the daemon model list (and any other
 * surface that renders model capabilities) so UI icons stay in sync with the
 * canonical catalog instead of each view re-inventing the substring checks.
 *
 * The `inputModalities` array feeds the understanding flags (text/image/
 * video); the generation flags additionally rely on id-family knowledge the
 * catalog already carries (`generate_image`-capable hosted models, Agnes
 * video generation, etc.).
 */
export interface ModelCapabilities {
	/** Accepts text input (nearly every model; a few image/video-only
	 *  generators do not). */
	text: boolean;
	/** Accepts image input (image understanding). */
	image: boolean;
	/** Accepts video input (video understanding). */
	video: boolean;
	/** Can generate images (hosted image-generation models, e.g. gpt-image-*,
	 *  agnes-image-*, DALL-E, flux, …). */
	imageGen: boolean;
	/** Can generate videos (hosted video-generation models, e.g.
	 *  agnes-video-*, veo, sora, …). */
	videoGen: boolean;
}

/** Normalize a model id for capability token matching. */
function normalizeModelToken(value: string): string {
	return value.trim().toLowerCase();
}

/**
 * Id tokens that identify hosted image-generation models. Mirrors the
 * `generate_image` tool's per-provider ID expectations (agnes-image, DALL-E
 * family, gpt-image, …) without claiming every model that mentions "image".
 */
const IMAGE_GEN_ID_PATTERNS = [
	/(^|[/:._-])gpt-image[/:._-]/,
	/(^|[/:._-])dall-e(?:\.|[/:._-]|$)/,
	/(^|[/:._-])dalle(?:\.|[/:._-]|$)/,
	/(^|[/:._-])agnes-image[/:._-]/,
	/(^|[/:._-])(?:flux|imagen)[/:._-]/,
] as const;

/** Id tokens that identify hosted video-generation models (Agnes video, Veo, Sora, …). */
const VIDEO_GEN_ID_PATTERNS = [
	/(^|[/:._-])agnes-video[/:._-]/,
	/(^|[/:._-])veo(?:\.|[/:._-]|$)/,
	/(^|[/:._-])sora(?:\.|[/:._-]|$)/,
] as const;

/**
 * Resolve the full capability set for one model from its declared input
 * modalities plus id/family knowledge.
 */
export function resolveModelCapabilities(
	modelId: string,
	inputModalities: readonly string[] | undefined,
): ModelCapabilities {
	const tokens = normalizeModelToken(modelId);
	const input = inputModalities ?? [];
	const contains = (modality: string): boolean => input.some(item => item.toLowerCase() === modality);
	// Text is the universal input: treat it as supported unless the model
	// explicitly declares only non-text modalities.
	const text = input.length === 0 ? true : contains("text");
	const image = contains("image") || isKimiK3ModelId(tokens);
	const video = contains("video") || isKimiK3ModelId(tokens);
	// Kimi K3 accepts video input per the vendor catalog; the bundled
	// models.json typically declares `["text","image"]` without the video
	// modality, so the family check above restores the video-understanding
	// flag for surfaces that render it.
	const imageGen = IMAGE_GEN_ID_PATTERNS.some(pattern => pattern.test(tokens));
	const videoGen = VIDEO_GEN_ID_PATTERNS.some(pattern => pattern.test(tokens));
	return { text, image, video, imageGen, videoGen };
}
