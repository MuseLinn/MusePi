/**
 * Zod validation schemas for the auth-broker wire protocol.
 *
 * Shared between the broker server (request validation) and client
 * (response validation). Schemas mirror the TypeScript types in `./types.ts`.
 */

import { z } from "zod";

const refresherSheduleSchema = z.object({
	enabled: z.boolean(),
	intervalMs: z.number(),
	skewMs: z.number(),
	nextSweepAt: z.number(),
});

const snapshotEntrySchema = z.object({
	id: z.number(),
	provider: z.string(),
	type: z.enum(["api_key", "oauth"]),
	remark: z.string().nullable(),
	email: z.string().nullable(),
	orgId: z.string().nullable(),
	orgName: z.string().nullable(),
	accountId: z.string().nullable(),
	identityKey: z.string().nullable(),
	access: z.string().nullable(),
	expires: z.number().nullable(),
	disabledCause: z.string().nullable(),
	createdAt: z.number(),
	updatedAt: z.number(),
	active: z.boolean(),
});

export const snapshotResponseSchema = z.object({
	generation: z.number(),
	generatedAt: z.number(),
	serverNowMs: z.number(),
	refresher: refresherSheduleSchema,
	credentials: z.array(snapshotEntrySchema),
});

export const healthzResponseSchema = z.object({
	ok: z.literal(true),
	version: z.string().optional(),
});

export const usageReportSchema = z.object({
	credential: z.object({ provider: z.string(), id: z.number() }),
	limits: z.array(
		z.object({
			id: z.string(),
			used: z.number(),
			limit: z.number(),
			resetsAt: z.number(),
		}),
	),
});

export const usageResponseSchema = z.object({
	generatedAt: z.number(),
	reports: z.array(usageReportSchema),
});
export const usageStaleResponseSchema = z.object({
	ok: z.boolean(),
});

export const credentialRefreshResponseSchema = z.object({
	entry: snapshotEntrySchema,
});

export const credentialDisableRequestSchema = z.object({
	cause: z.string(),
});

export const credentialDisableResponseSchema = z.object({
	ok: z.literal(true),
});

export const credentialBlockRequestSchema = z.object({
	providerKey: z.string(),
	blockScope: z.string(),
	blockedUntilMs: z.number(),
});

export const credentialBlockResponseSchema = z.object({
	ok: z.literal(true),
});

export const credentialRemarkRequestSchema = z.object({
	remark: z.string(),
});

export const credentialRemarkResponseSchema = z.object({
	ok: z.literal(true),
});
export const credentialBlocksDeleteResponseSchema = z.object({
	ok: z.boolean(),
});

export const credentialUploadRequestSchema = z.object({
	provider: z.string(),
	credential: z
		.object({
			type: z.literal("oauth"),
			access: z.string(),
			refresh: z.string(),
			expires: z.number(),
		})
		.passthrough(),
});

export const credentialUploadResponseSchema = z.object({
	entries: z.array(snapshotEntrySchema),
});

export const snapshotStreamEventSchema = z.discriminatedUnion("kind", [
	snapshotResponseSchema.extend({ kind: z.literal("snapshot") }),
	z.object({ kind: z.literal("entry"), entry: snapshotEntrySchema, generation: z.number() }),
	z.object({ kind: z.literal("removed"), id: z.number(), generation: z.number() }),
]);
