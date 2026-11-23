#!/usr/bin/env bun
/**
 * Project each plugin's `Config` schema into its form sidecar (`config.json`).
 *
 * `Config` is the authored contract; the management page needs a serializable
 * field table. Generating it from `toJsonSchema()` keeps one fact in one place:
 * a type, default, bound, option or description lives only in the schema, and a
 * stale sidecar fails `verify-generated` instead of shipping.
 */
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ConfigFieldDesc } from "@musepi/pi-wire";
import { isVolatileSchema } from "../src/plugin-config";

const ROOT = path.resolve(import.meta.dir, "..");

interface JsonSchemaNode {
	type?: unknown;
	enum?: unknown;
	default?: unknown;
	minimum?: unknown;
	maximum?: unknown;
	description?: unknown;
	properties?: Record<string, JsonSchemaNode>;
}

/** One JSON Schema node as the management page's field descriptor. */
export function projectConfigFields(schema: JsonSchemaNode, shape?: Record<string, unknown>): ConfigFieldDesc[] {
	const fields: ConfigFieldDesc[] = [];
	for (const [key, property] of Object.entries(schema.properties ?? {})) {
		const options = Array.isArray(property.enum)
			? property.enum.filter((option): option is string => typeof option === "string")
			: undefined;
		const type: ConfigFieldDesc["type"] =
			options && options.length > 0
				? "select"
				: property.type === "boolean"
					? "boolean"
					: property.type === "number" || property.type === "integer"
						? "number"
						: property.type === "array"
							? "list"
							: "string";
		fields.push({
			key,
			type,
			label: key,
			// A volatile field is live; ordinary config is read when the plugin mounts.
			restart: isVolatileSchema(shape?.[key]) ? "none" : "session",
			...(property.default !== undefined ? { default: property.default } : {}),
			...(typeof property.minimum === "number" ? { min: property.minimum } : {}),
			...(typeof property.maximum === "number" ? { max: property.maximum } : {}),
			...(options ? { options } : {}),
			...(typeof property.description === "string" ? { description: property.description } : {}),
		});
	}
	return fields;
}

export interface PluginConfigArtifact {
	path: string;
	content: string;
}

/** Every generated sidecar, in a stable order. */
export async function buildPluginConfigArtifacts(): Promise<PluginConfigArtifact[]> {
	const artifacts: PluginConfigArtifact[] = [];
	const manifests = [...new Bun.Glob("src/plugins/**/package.json").scanSync({ cwd: ROOT })].sort();
	for (const relative of manifests) {
		const dir = path.dirname(path.join(ROOT, relative));
		const configPath = path.join(dir, "config.ts");
		if (!(await Bun.file(configPath).exists())) continue;
		const module = (await import(pathToFileURL(configPath).href)) as {
			Config?: { toJsonSchema?: () => JsonSchemaNode };
		};
		const schema = module.Config;
		if (!schema || typeof schema.toJsonSchema !== "function") {
			throw new Error(`${relative}: Config must expose toJsonSchema()`);
		}
		const fields = projectConfigFields(schema.toJsonSchema(), (schema as { shape?: Record<string, unknown> }).shape);
		artifacts.push({
			path: path.join(dir, "config.json"),
			content: `${JSON.stringify({ fields }, null, "\t")}\n`,
		});
	}
	return artifacts;
}

if (import.meta.main) {
	const artifacts = await buildPluginConfigArtifacts();
	for (const artifact of artifacts) await Bun.write(artifact.path, artifact.content);
	console.log(`wrote ${artifacts.length} plugin config sidecars`);
}
