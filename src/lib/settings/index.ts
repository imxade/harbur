import type { AppConfig, AppSettings, RepositoryPolicy } from "../types"
import {
	APP_BACKUP,
	APP_DOWNLOAD,
	APP_GITHUB_MIRROR,
	APP_SCHEMA,
	APP_SLUG,
} from "../app-config"

export const DEFAULT_REPOSITORY_POLICY: RepositoryPolicy = {
	issuesEnabled: true,
	prsEnabled: true,
	allowUserCloseOwnIssues: true,
	requiredStatusForMerge: "none",
}

export function createDefaultSettings(
	updatedBy = "bootstrap",
	now = new Date().toISOString(),
): AppSettings {
	return {
		schema: APP_SCHEMA.settings,
		ownerName: createDefaultOwnerName(),
		allowPublicGitMirrors: false,
		githubMirrorSyncIntervalHours: APP_GITHUB_MIRROR.defaultSyncIntervalHours,
		defaultRepoVisibility: "public",
		defaultRepoPolicy: DEFAULT_REPOSITORY_POLICY,
		prAutoCleanDays: 0,
		backupSyncIntervalHours: APP_BACKUP.defaultSyncIntervalHours,
		downloadCleanupDelayMs: APP_DOWNLOAD.cleanupDelayMs,
		uploadLimits: {
			maxRepoUploadBytes: 2_147_483_648,
			maxPrUploadBytes: 536_870_912,
			maxSingleFileBytes: 104_857_600,
			maxFilesPerUpload: 20_000,
		},
		backupTargets: [],
		updatedAt: now,
		updatedBy,
	}
}

function createDefaultOwnerName() {
	const suffix =
		typeof crypto !== "undefined" && "randomUUID" in crypto
			? crypto.randomUUID().slice(0, 8)
			: Math.random().toString(36).slice(2, 10)
	return `${APP_SLUG}-${suffix}`
}

export function createBootstrapConfig(
	publicReposFolderId = "",
	publicReposFolderUrl = "",
): AppConfig {
	return {
		provider: "google-drive",
		publicReposFolderId,
		publicReposFolderUrl,
		appDataVersion: 1,
	}
}
