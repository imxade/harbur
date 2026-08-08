export const APP_NAME = "Harbur"
export const APP_SLUG = "harbur"
export const APP_GITHUB_URL = "https://github.com/imxade/harbur"

export const APP_ENV = {
	adminEmails: "APP_ADMIN_EMAILS",
	googleDriveClientId: "GOOGLE_DRIVE_CLIENT_ID",
	googleDriveClientSecret: "GOOGLE_DRIVE_CLIENT_SECRET",
	googleDriveRefreshToken: "GOOGLE_DRIVE_REFRESH_TOKEN",
	googleDriveBrowserApiKey: "GOOGLE_DRIVE_BROWSER_API_KEY",
	integrationReadToken: "INTEGRATION_READ_TOKEN",
	timing: "HARBUR_TIMING",
} as const

export const APP_FILES = {
	localEnvFileName: ".env.local",
} as const

export const APP_SCHEMA = {
	state: `${APP_SLUG}.appdata.v1`,
	settings: `${APP_SLUG}.settings.v1`,
	repository: `${APP_SLUG}.repository.v1`,
	repositoryState: `${APP_SLUG}.repository-state.v1`,
	repositoryThread: `${APP_SLUG}.repository-thread.v1`,
	repositoryAppend: `${APP_SLUG}.repository-append.v1`,
} as const

export const APP_STORAGE = {
	rootFolderName: APP_NAME,
	appDataFileName: `${APP_SCHEMA.state}.json`,
	repositoryZipFileName: `${APP_SLUG}.repository.zip`,
	repositoryManifestFileName: `${APP_SLUG}.repository.json`,
	pullRequestFolderPrefix: "pull",
	stagedUploadFolderPrefix: "upload",
	stagedDownloadFolderPrefix: "download",
	stagedUploadZipFileName: `${APP_SLUG}.upload.zip`,
	repositoryAppendCompactionThreshold: 5,
	readmeAssetMaxFiles: 20,
	readmeAssetMaxBytes: 2 * 1024 * 1024,
	pullRequestBaseSidecarMaxFiles: 200,
	pullRequestBaseSidecarMaxBytes: 2 * 1024 * 1024,
} as const

export const APP_SESSION = {
	productionCookieName: `__Host-${APP_SLUG}_session`,
	developmentCookieName: `${APP_SLUG}_session`,
	passwordPrefix: `${APP_SLUG}-session`,
	maxAgeSeconds: 60 * 60 * 24 * 400,
	fallbackAccessTokenExpiresInSeconds: 3600,
} as const

export const APP_TIMING = {
	enabledValue: "1",
	logPrefix: `[${APP_SLUG}:timing]`,
	slowSpanMs: 1000,
	msPerSecond: 1000,
	msPerHour: 60 * 60 * 1000,
	msPerDay: 24 * 60 * 60 * 1000,
} as const

export const APP_BACKUP = {
	defaultSyncIntervalHours: 24,
} as const

export const APP_UPLOAD = {
	clientZipCompressionLevel: 3,
	zipUploadTicketTtlMs: 2 * 60 * 60 * 1000,
	stagedUploadSweepGraceMs: APP_TIMING.msPerHour,
	stagedUploadSweepMaxDeletes: 10,
	driveQuotaSafetyBytes: 10 * 1024 * 1024,
} as const

export const APP_DOWNLOAD = {
	cleanupDelayMs: 0,
	cleanupGraceMs: APP_TIMING.msPerHour,
	stagedDownloadSweepMaxDeletes: 10,
} as const

export const APP_GITHUB_MIRROR = {
	defaultSyncIntervalHours: 24,
} as const

export const GOOGLE_AUTH = {
	gisScriptUrl: "https://accounts.google.com/gsi/client",
	tokenUrl: "https://oauth2.googleapis.com/token",
	tokenInfoUrl: "https://oauth2.googleapis.com/tokeninfo",
	userInfoUrl: "https://www.googleapis.com/oauth2/v3/userinfo",
	loginScopes: ["openid", "email"],
	driveConsentScopes: [
		"openid",
		"email",
		"https://www.googleapis.com/auth/drive.file",
		"https://www.googleapis.com/auth/drive.appdata",
	],
	loginTimeoutMs: 60_000,
} as const

export const GOOGLE_DRIVE_API = {
	aboutUrl: "https://www.googleapis.com/drive/v3/about",
	filesUrl: "https://www.googleapis.com/drive/v3/files",
	uploadFilesUrl: "https://www.googleapis.com/upload/drive/v3/files",
	exactSearchPageSize: 10,
	prefixSearchPageSize: 1000,
} as const
