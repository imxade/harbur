import { z } from "zod"
import { APP_DOWNLOAD, APP_SCHEMA } from "./app-config"

const storageProviderSchema = z.literal("google-drive")

export const repositoryPolicySchema = z.object({
	issuesEnabled: z.boolean(),
	prsEnabled: z.boolean(),
	allowUserCloseOwnIssues: z.boolean(),
	requiredStatusForMerge: z.enum(["none", "reviewed"]),
})
export type RepositoryPolicy = z.infer<typeof repositoryPolicySchema>

const uploadLimitsSchema = z.object({
	maxRepoUploadBytes: z.number().int().nonnegative(),
	maxPrUploadBytes: z.number().int().nonnegative(),
	maxSingleFileBytes: z.number().int().nonnegative(),
	maxFilesPerUpload: z.number().int().nonnegative(),
})
const backupDriveTargetSchema = z.object({
	id: z.string().min(1),
	provider: storageProviderSchema,
	accountEmail: z.string().email(),
	rootFolderId: z.string().min(1),
	enabled: z.boolean(),
	credentialRef: z.string().min(1),
	lastSyncAt: z.string().optional(),
	lastSyncStatus: z.enum(["ok", "failed", "pending"]).optional(),
})
export type BackupDriveTarget = z.infer<typeof backupDriveTargetSchema>

const backupDriveCredentialSchema = z.object({
	id: z.string().min(1),
	provider: storageProviderSchema,
	accountEmail: z.string().email(),
	refreshToken: z.string().min(1),
	createdAt: z.string(),
	updatedAt: z.string(),
})
export type BackupDriveCredential = z.infer<typeof backupDriveCredentialSchema>

export const appSettingsSchema = z.object({
	schema: z.literal(APP_SCHEMA.settings),
	ownerName: z.string().min(1),
	allowPublicGitMirrors: z.boolean(),
	githubMirrorSyncIntervalHours: z.number().int().nonnegative(),
	defaultRepoVisibility: z.enum(["public", "private"]),
	defaultRepoPolicy: repositoryPolicySchema,
	prAutoCleanDays: z.number().int().nonnegative(),
	backupSyncIntervalHours: z.number().int().nonnegative(),
	downloadCleanupDelayMs: z
		.number()
		.int()
		.nonnegative()
		.default(APP_DOWNLOAD.cleanupDelayMs),
	uploadLimits: uploadLimitsSchema,
	backupTargets: z.array(backupDriveTargetSchema),
	updatedAt: z.string(),
	updatedBy: z.string().min(1),
})
export type AppSettings = z.infer<typeof appSettingsSchema>

const appConfigSchema = z.object({
	provider: storageProviderSchema,
	publicReposFolderUrl: z.string().default(""),
	publicReposFolderId: z.string().default(""),
	appDataVersion: z.literal(1),
})
export type AppConfig = z.infer<typeof appConfigSchema>

const labelDefinitionSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
	description: z.string().optional(),
})
const maintainerSchema = z.object({
	userId: z.string().min(1),
	email: z.string().email(),
	permissions: z.array(z.enum(["triage", "merge", "settings"])),
})
const repositoryAccessGrantSchema = z.object({
	email: z.string().email(),
	addedAt: z.string(),
	addedBy: z.string().min(1),
})
export type RepositoryAccessGrant = z.infer<typeof repositoryAccessGrantSchema>

export const githubMirrorSchema = z.object({
	type: z.literal("github"),
	owner: z.string().min(1),
	repo: z.string().min(1),
	branch: z.string().min(1),
	htmlUrl: z.string().url(),
	zipUrl: z.string().url(),
	lastSyncedAt: z.string().optional(),
	lastSyncStatus: z.enum(["ok", "failed"]).optional(),
	lastSyncError: z.string().optional(),
})
export type GitHubMirror = z.infer<typeof githubMirrorSchema>

const repositoryManifestSchema = z.object({
	schema: z.literal(APP_SCHEMA.repository),
	id: z.string().min(1),
	owner: z.string().min(1),
	name: z.string().min(1),
	description: z.string().optional(),
	defaultBranch: z.string().min(1),
	vcs: z.enum(["git", "fossil", "folder"]),
	visibility: z.enum(["public", "private"]),
	rootFolderId: z.string().min(1),
	policy: repositoryPolicySchema,
	maintainers: z.array(maintainerSchema),
	access: z.array(repositoryAccessGrantSchema).default([]),
	githubMirror: githubMirrorSchema.optional(),
	labels: z.array(labelDefinitionSchema),
	archived: z.boolean(),
	createdAt: z.string(),
	updatedAt: z.string(),
})
export type RepositoryManifest = z.infer<typeof repositoryManifestSchema>

export type Actor = {
	id: string
	email: string
	role: "anonymous" | "user" | "admin"
}

export type RepositoryFile = {
	path: string
	content: Uint8Array | string
	encoding?: "utf8" | "base64"
	size: number
	contentHash?: string
	modifiedAt?: string
}
