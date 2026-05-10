import { createServerFn } from "@tanstack/react-start"
import {
	clearSession,
	getRequestHeader,
	updateSession,
	useSession,
} from "@tanstack/react-start/server"
import { createHmac, timingSafeEqual } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import {
	beginGitHubMirrorSyncArchiveUpload,
	beginMergedRepositoryArchiveUpload,
	beginRepositoryArchiveUpload,
	beginPullRequestArchiveUpload,
	cancelZipArchiveUpload,
	closePullRequestInDriveState,
	commentOnIssueInDriveState,
	commentOnPullRequestInDriveState,
	completeRepositoryArchiveUpload,
	completeGitHubMirrorSyncUploadInDriveState,
	completePullRequestMergeUploadInDriveState,
	completePullRequestArchiveUpload,
	connectBackupDrive,
	createIssueInDriveState,
	deleteBackupDrive,
	deleteRepositoryFromDrive,
	disconnectBackupDrive,
	editIssueTitleInDriveState,
	editIssueMessageInDriveState,
	editPullRequestTitleInDriveState,
	editPullRequestMessageInDriveState,
	hasDueBackupSync,
	loadOrCreateAppState,
	markNotificationsReadInDriveState,
	createRepositoryZipDownloadLink,
	createPullRequestZipDownloadLink,
	revokeZipDownloadLink,
	reviewPullRequestInDriveState,
	setRepositoryWatch,
	stateWithDriveStorageQuota,
	sweepStaleZipUploadFolders,
	syncConnectedBackupDrives,
	transitionIssueInDriveState,
	updateAppSettings,
	updateRepositoryAccessInDriveState,
	updateUserNameInDriveState,
	type AppState,
} from "./drive-state"
import { ANONYMOUS_ACTOR, isAdminEmail } from "./auth"
import {
	APP_ENV,
	APP_FILES,
	APP_SESSION,
	APP_TIMING,
	APP_UPLOAD,
	APP_DOWNLOAD,
	GOOGLE_AUTH,
} from "./app-config"
import type { IssueState } from "./issues"
import { assertCanMergePullRequest } from "./pulls"
import {
	appSettingsSchema,
	githubMirrorSchema,
	repositoryPolicySchema,
	type Actor,
	type RepositoryManifest,
} from "./types"
import { timed, timedWithBreakdown } from "./timing"

const SESSION_NAME =
	process.env.NODE_ENV === "production"
		? APP_SESSION.productionCookieName
		: APP_SESSION.developmentCookieName

type AppSession = {
	user: {
		id: string
		email: string
		role: Actor["role"]
	}
}

const repositoryUploadFileMetadataSchema = z.object({
	path: z.string().min(1),
	size: z.number().int().nonnegative(),
	contentHash: z.string().min(1),
	modifiedAt: z.string().optional(),
	content: z.union([z.string(), z.instanceof(Uint8Array)]).optional(),
	encoding: z.enum(["utf8", "base64"]).optional(),
})
const repositoryRootFolderIdSchema = z.string().min(1).optional()
const fileDiffSchema = z.object({
	path: z.string().min(1),
	status: z.enum(["added", "modified", "deleted", "unchanged"]),
	beforeHash: z.string().optional(),
	afterHash: z.string().optional(),
})
const beginZipUploadInputSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("repository"),
		name: z.string().min(1),
		zipBytes: z.number().int().positive(),
		origin: z.string().url(),
	}),
	z.object({
		kind: z.literal("pull-request"),
		repositoryId: z.string().min(1),
		repositoryRootFolderId: repositoryRootFolderIdSchema,
		baseRepositoryZipFileId: z.string().min(1),
		zipBytes: z.number().int().positive(),
		origin: z.string().url(),
	}),
	z.object({
		kind: z.literal("pull-merge"),
		repositoryId: z.string().min(1),
		repositoryRootFolderId: repositoryRootFolderIdSchema,
		pullRequestNumber: z.number().int().positive(),
		baseRepositoryZipFileId: z.string().min(1),
		zipBytes: z.number().int().positive(),
		origin: z.string().url(),
	}),
	z.object({
		kind: z.literal("github-mirror-sync"),
		repositoryId: z.string().min(1),
		repositoryRootFolderId: repositoryRootFolderIdSchema,
		baseRepositoryZipFileId: z.string().min(1),
		zipBytes: z.number().int().positive(),
		origin: z.string().url(),
	}),
])
const completeRepositoryUploadInputSchema = z.object({
	name: z.string().min(1),
	description: z.string().optional(),
	repositoryZipFileId: z.string().min(1),
	uploadTicket: z.string().min(1),
	files: z.array(repositoryUploadFileMetadataSchema),
	githubMirror: githubMirrorSchema.optional(),
})
const completePullRequestUploadInputSchema = z.object({
	repositoryId: z.string().min(1),
	repositoryRootFolderId: repositoryRootFolderIdSchema,
	title: z.string().min(1),
	body: z.string().min(1),
	uploadZipFileId: z.string().min(1),
	uploadTicket: z.string().min(1),
	files: z.array(repositoryUploadFileMetadataSchema),
	baseFiles: z.array(repositoryUploadFileMetadataSchema),
	diff: z.array(fileDiffSchema),
})
const completePullRequestMergeUploadInputSchema = z.object({
	repositoryId: z.string().min(1),
	repositoryRootFolderId: repositoryRootFolderIdSchema,
	pullRequestNumber: z.number().int().positive(),
	repositoryZipFileId: z.string().min(1),
	uploadTicket: z.string().min(1),
	files: z.array(repositoryUploadFileMetadataSchema),
})
const completeGitHubMirrorSyncUploadInputSchema = z.object({
	repositoryId: z.string().min(1),
	repositoryRootFolderId: repositoryRootFolderIdSchema,
	repositoryZipFileId: z.string().min(1),
	uploadTicket: z.string().min(1),
	files: z.array(repositoryUploadFileMetadataSchema),
	githubMirror: githubMirrorSchema,
})
const cancelZipUploadInputSchema = z.object({
	uploadTicket: z.string().min(1),
})
const revokeZipDownloadInputSchema = z.object({
	downloadTicket: z.string().min(1),
})
const zipUploadTicketPayloadSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("repository"),
		actorEmail: z.string().email(),
		owner: z.string().min(1),
		name: z.string().min(1),
		uploadFolderId: z.string().min(1),
		zipBytes: z.number().int().positive(),
		origin: z.string().url(),
		expiresAt: z.number().int().positive(),
	}),
	z.object({
		kind: z.literal("pull-request"),
		actorEmail: z.string().email(),
		repositoryId: z.string().min(1),
		repositoryRootFolderId: z.string().min(1),
		uploadFolderId: z.string().min(1),
		baseRepositoryZipFileId: z.string().min(1),
		zipBytes: z.number().int().positive(),
		origin: z.string().url(),
		expiresAt: z.number().int().positive(),
	}),
	z.object({
		kind: z.literal("pull-merge"),
		actorEmail: z.string().email(),
		repositoryId: z.string().min(1),
		repositoryRootFolderId: z.string().min(1),
		pullRequestNumber: z.number().int().positive(),
		uploadFolderId: z.string().min(1),
		baseRepositoryZipFileId: z.string().min(1),
		zipBytes: z.number().int().positive(),
		origin: z.string().url(),
		expiresAt: z.number().int().positive(),
	}),
	z.object({
		kind: z.literal("github-mirror-sync"),
		actorEmail: z.string().email(),
		repositoryId: z.string().min(1),
		repositoryRootFolderId: z.string().min(1),
		uploadFolderId: z.string().min(1),
		baseRepositoryZipFileId: z.string().min(1),
		zipBytes: z.number().int().positive(),
		origin: z.string().url(),
		expiresAt: z.number().int().positive(),
	}),
])
type ZipUploadTicketPayload = z.infer<typeof zipUploadTicketPayloadSchema>
const zipDownloadTicketPayloadSchema = z.object({
	kind: z.literal("zip-download"),
	actorId: z.string().min(1),
	fileId: z.string().min(1),
	folderId: z.string().min(1),
	permissionId: z.string().min(1),
	origin: z.string(),
	expiresAt: z.number().int().positive(),
})
type ZipDownloadTicketPayload = z.infer<typeof zipDownloadTicketPayloadSchema>

const issueStateSchema = z.enum(["open", "closed"])
const accessTokenCache = new Map<string, { token: string; expiresAt: number }>()

function serverSecret() {
	const clientSecret = process.env[APP_ENV.googleDriveClientSecret]
	if (!clientSecret) {
		throw new Error("Server Google client secret is not configured.")
	}
	return clientSecret
}

function getSessionConfig() {
	return {
		password: `${APP_SESSION.passwordPrefix}:${serverSecret()}`,
		name: SESSION_NAME,
		maxAge: APP_SESSION.maxAgeSeconds,
		cookie: {
			httpOnly: true,
			sameSite: "lax" as const,
			secure: process.env.NODE_ENV === "production",
			path: "/",
		},
	}
}

function currentRequestOrigin() {
	return getRequestHeader("origin") ?? ""
}

function assertRequestOrigin(expectedOrigin: string) {
	const origin = currentRequestOrigin()
	if (origin && origin !== expectedOrigin) {
		throw new Error("Request origin does not match this request.")
	}
}

function signZipUploadTicket(payload: ZipUploadTicketPayload) {
	const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
	const signature = createHmac("sha256", serverSecret())
		.update(body)
		.digest("base64url")
	return `${body}.${signature}`
}

function verifyZipUploadTicket(ticket: string) {
	const [body, signature] = ticket.split(".")
	if (!body || !signature) throw new Error("ZIP upload ticket is invalid.")
	const expected = createHmac("sha256", serverSecret())
		.update(body)
		.digest("base64url")
	const actualBytes = Buffer.from(signature)
	const expectedBytes = Buffer.from(expected)
	if (
		actualBytes.length !== expectedBytes.length ||
		!timingSafeEqual(actualBytes, expectedBytes)
	) {
		throw new Error("ZIP upload ticket is invalid.")
	}
	const payload = zipUploadTicketPayloadSchema.parse(
		JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
	)
	if (Date.now() > payload.expiresAt) {
		throw new Error("ZIP upload ticket expired. Start the upload again.")
	}
	assertRequestOrigin(payload.origin)
	return payload
}

function signZipDownloadTicket(payload: ZipDownloadTicketPayload) {
	const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
	const signature = createHmac("sha256", serverSecret())
		.update(body)
		.digest("base64url")
	return `${body}.${signature}`
}

function verifyZipDownloadTicket(ticket: string) {
	const [body, signature] = ticket.split(".")
	if (!body || !signature) throw new Error("ZIP download ticket is invalid.")
	const expected = createHmac("sha256", serverSecret())
		.update(body)
		.digest("base64url")
	const actualBytes = Buffer.from(signature)
	const expectedBytes = Buffer.from(expected)
	if (
		actualBytes.length !== expectedBytes.length ||
		!timingSafeEqual(actualBytes, expectedBytes)
	) {
		throw new Error("ZIP download ticket is invalid.")
	}
	const payload = zipDownloadTicketPayloadSchema.parse(
		JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
	)
	if (Date.now() > payload.expiresAt) {
		throw new Error("ZIP download ticket expired.")
	}
	assertRequestOrigin(payload.origin)
	return payload
}

async function getAppSession() {
	return await useSession<AppSession>(getSessionConfig())
}

function roleForEmail(email: string): Actor["role"] {
	return isAdminEmail(email, process.env[APP_ENV.adminEmails] ?? "")
		? "admin"
		: "user"
}

async function requireSession() {
	const session = await getAppSession()
	const user = session.data.user
	if (!user) throw new Error("Sign in first.")
	const refreshedUser = { ...user, role: roleForEmail(user.email) }
	await updateSession(getSessionConfig(), { user: refreshedUser })
	return {
		session,
		user: refreshedUser,
		actor: {
			id: refreshedUser.id,
			email: refreshedUser.email,
			role: refreshedUser.role,
		} satisfies Actor,
	}
}

async function optionalActor() {
	const session = await getAppSession()
	const user = session.data.user
	if (!user) {
		return ANONYMOUS_ACTOR
	}
	const refreshedUser = { ...user, role: roleForEmail(user.email) }
	await updateSession(getSessionConfig(), { user: refreshedUser })
	return {
		id: refreshedUser.id,
		email: refreshedUser.email,
		role: refreshedUser.role,
	} satisfies Actor
}

function requireAdmin(actor: Actor) {
	if (actor.role !== "admin") throw new Error("Admin access is required.")
}

function googleClientId() {
	return process.env[APP_ENV.googleDriveClientId]?.trim() ?? ""
}

function googleDriveBrowserApiKey() {
	const key = process.env[APP_ENV.googleDriveBrowserApiKey]?.trim()
	if (!key) {
		throw new Error(
			`${APP_ENV.googleDriveBrowserApiKey} is required for ZIP downloads.`,
		)
	}
	return key
}

async function ownerDriveAccessToken() {
	const refreshToken = process.env[APP_ENV.googleDriveRefreshToken]
	const clientId = googleClientId()
	const clientSecret = process.env[APP_ENV.googleDriveClientSecret]
	if (!refreshToken || !clientId || !clientSecret) {
		throw new Error(
			`Owner Drive authorization is not configured. Set ${APP_ENV.googleDriveClientId}, ${APP_ENV.googleDriveClientSecret}, and ${APP_ENV.googleDriveRefreshToken}.`,
		)
	}

	return await timed("drive.token.owner", () =>
		refreshGoogleAccessToken(refreshToken),
	)
}

async function refreshGoogleAccessToken(refreshToken: string) {
	const clientId = googleClientId()
	const clientSecret = process.env[APP_ENV.googleDriveClientSecret]
	if (!refreshToken || !clientId || !clientSecret) {
		throw new Error("Google Drive authorization is not configured.")
	}
	const cacheKey = `${clientId}:${refreshToken.slice(-16)}`
	const cached = accessTokenCache.get(cacheKey)
	if (cached && cached.expiresAt > Date.now() + 60 * APP_TIMING.msPerSecond) {
		return cached.token
	}
	const response = await timed("drive.token.refresh", () =>
		fetch(GOOGLE_AUTH.tokenUrl, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: clientId,
				client_secret: clientSecret,
				refresh_token: refreshToken,
				grant_type: "refresh_token",
			}),
		}),
	)
	if (!response.ok) {
		throw new Error(`Owner Drive token refresh failed: ${response.status}`)
	}
	const data = (await response.json()) as {
		access_token?: string
		expires_in?: number
	}
	if (!data.access_token)
		throw new Error("Google Drive token refresh returned no access token.")
	accessTokenCache.set(cacheKey, {
		token: data.access_token,
		expiresAt:
			Date.now() +
			(data.expires_in ?? APP_SESSION.fallbackAccessTokenExpiresInSeconds) *
				APP_TIMING.msPerSecond,
	})
	return data.access_token
}

async function exchangeGoogleAuthorizationCode(
	code: string,
	redirectUri: string,
) {
	const clientId = googleClientId()
	const clientSecret = process.env[APP_ENV.googleDriveClientSecret]
	if (!clientId || !clientSecret) {
		throw new Error("Google OAuth client is not configured.")
	}
	assertRequestOrigin(redirectUri)
	const response = await fetch(GOOGLE_AUTH.tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			code,
			redirect_uri: redirectUri,
			grant_type: "authorization_code",
		}),
	})
	if (!response.ok) {
		throw new Error(`Google authorization failed: ${response.status}`)
	}
	const data = (await response.json()) as {
		access_token?: string
		refresh_token?: string
		id_token?: string
	}
	if (!data.access_token) {
		throw new Error("Google authorization returned no access token.")
	}
	return data
}

async function exchangeBackupDriveCode(code: string, redirectUri: string) {
	const data = await exchangeGoogleAuthorizationCode(code, redirectUri)
	if (!data.access_token) {
		throw new Error("Backup Drive authorization returned no access token.")
	}
	if (!data.refresh_token) {
		throw new Error(
			"Backup Drive authorization returned no refresh token. Reconnect and approve offline Drive access.",
		)
	}
	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		accountEmail: await googleAccountEmail(data.access_token),
	}
}

async function googleAccountEmail(accessToken: string) {
	const response = await fetch(GOOGLE_AUTH.userInfoUrl, {
		headers: { Authorization: `Bearer ${accessToken}` },
	})
	if (!response.ok) throw new Error("Could not read Google account profile.")
	const data = (await response.json()) as { email?: string }
	if (!data.email) throw new Error("Google account profile has no email.")
	return data.email
}

async function persistLocalEnvValue(name: string, value: string) {
	const envPath = join(process.cwd(), APP_FILES.localEnvFileName)
	let current = ""
	try {
		current = await readFile(envPath, "utf8")
	} catch {
		current = ""
	}
	const escapedValue = JSON.stringify(value)
	const line = `${name}=${escapedValue}`
	const pattern = new RegExp(`^${name}=.*$`, "m")
	const next = pattern.test(current)
		? current.replace(pattern, line)
		: `${current.trimEnd()}${current.trim() ? "\n" : ""}${line}\n`
	await writeFile(envPath, next)
}

async function loadStateForUser(
	email?: string,
	options?: Parameters<typeof loadOrCreateAppState>[2],
) {
	return await timedWithBreakdown(
		"state.load",
		async () =>
			await loadOrCreateAppState(
				await ownerDriveAccessToken(),
				email ?? "",
				options,
			),
		{
			repositoryIds: options?.repositoryIds?.length ?? 0,
			repositoryHints: options?.repositoryHints?.length ?? 0,
			includeRepositoryDetails: options?.includeRepositoryDetails !== false,
			includeIssueThreadDetails: Boolean(options?.includeIssueThreadDetails),
			includePullRequestThreadDetails: Boolean(
				options?.includePullRequestThreadDetails,
			),
			issueNumbers: options?.issueNumbers?.length ?? 0,
			pullRequestNumbers: options?.pullRequestNumbers?.length ?? 0,
		},
	)
}

function repositoryHints({
	repositoryId,
	repositoryRootFolderId,
}: {
	repositoryId: string
	repositoryRootFolderId?: string
}) {
	return repositoryRootFolderId
		? [{ repositoryId, rootFolderId: repositoryRootFolderId }]
		: undefined
}

function canSeeRepository(repository: RepositoryManifest, actor: Actor) {
	if (repository.visibility === "public") return true
	if (actor.role === "admin") return true
	if (
		repository.maintainers.some(
			(maintainer) =>
				maintainer.email.toLowerCase() === actor.email.toLowerCase(),
		)
	) {
		return true
	}
	return repository.access?.some(
		(grant) => grant.email.toLowerCase() === actor.email.toLowerCase(),
	)
}

async function loadVisibleRepositoryState(
	actor: Actor,
	repositoryId: string,
	options?: {
		repositoryRootFolderId?: string
		includeIssueThreadDetails?: boolean
		includePullRequestThreadDetails?: boolean
		issueNumbers?: number[]
		pullRequestNumbers?: number[]
	},
) {
	const { repositoryRootFolderId, ...loadOptions } = options ?? {}
	const state = await loadStateForUser(
		actor.role === "anonymous" ? undefined : actor.email,
		{
			repositoryIds: [repositoryId],
			repositoryHints: repositoryHints({
				repositoryId,
				repositoryRootFolderId,
			}),
			...loadOptions,
		},
	)
	const repository = state.repositories.find(
		(candidate) =>
			candidate.id === repositoryId && canSeeRepository(candidate, actor),
	)
	if (!repository) {
		throw new Error("Repository not found.")
	}
	return { state: state as AppState, repository }
}

function actorDownloadId(actor: Actor) {
	return actor.role === "anonymous" ? "anonymous" : actor.email.toLowerCase()
}

function zipDownloadPayload(
	actor: Actor,
	link: {
		name: string
		fetchUrl: string
		fileId: string
		folderId: string
		permissionId: string
	},
	cleanupDelayMs: number,
) {
	return {
		name: link.name,
		fetchUrl: link.fetchUrl,
		downloadTicket: signZipDownloadTicket({
			kind: "zip-download",
			actorId: actorDownloadId(actor),
			fileId: link.fileId,
			folderId: link.folderId,
			permissionId: link.permissionId,
			origin: currentRequestOrigin(),
			expiresAt: Date.now() + cleanupDelayMs + APP_DOWNLOAD.cleanupGraceMs,
		}),
	}
}

function visibleStateForActor(state: AppState, actor: Actor) {
	const visibleRepositories = state.repositories.filter((repository) =>
		canSeeRepository(repository, actor),
	)
	const visibleIds = new Set(
		visibleRepositories.map((repository) => repository.id),
	)
	const filterRecord = <T>(record: Record<string, T>) =>
		Object.fromEntries(
			Object.entries(record).filter(([repositoryId]) =>
				visibleIds.has(repositoryId),
			),
		) as Record<string, T>
	const visibleThreadIds = new Set([
		...Object.entries(state.issues)
			.filter(([repositoryId]) => visibleIds.has(repositoryId))
			.flatMap(([, issues]) => issues.map((issue) => issue.id)),
		...Object.entries(state.pullRequests)
			.filter(([repositoryId]) => visibleIds.has(repositoryId))
			.flatMap(([, pullRequests]) =>
				pullRequests.map((pullRequest) => pullRequest.id),
			),
	])
	return {
		...state,
		repositories: visibleRepositories,
		repositoryFiles: filterRecord(state.repositoryFiles),
		repositoryReadmeFiles: filterRecord(state.repositoryReadmeFiles),
		repositoryZipFileIds: filterRecord(state.repositoryZipFileIds),
		issues: filterRecord(state.issues),
		pullRequests: filterRecord(state.pullRequests),
		pullRequestZipFileIds: Object.fromEntries(
			Object.entries(state.pullRequestZipFileIds).filter(([pullRequestId]) =>
				[...visibleIds].some((repositoryId) =>
					pullRequestId.startsWith(`${repositoryId}:pull:`),
				),
			),
		),
		watches:
			actor.role === "anonymous"
				? {}
				: {
						[actor.email.toLowerCase()]: (
							state.watches[actor.email.toLowerCase()] ?? []
						).filter((repositoryId) => visibleIds.has(repositoryId)),
					},
		notifications:
			actor.role === "anonymous"
				? {}
				: {
						[actor.email.toLowerCase()]: (
							state.notifications[actor.email.toLowerCase()] ?? []
						).filter((notification) =>
							visibleIds.has(notification.repositoryId),
						),
					},
		activity: state.activity.filter((record) =>
			visibleIds.has(record.repositoryId),
		),
		loadedRepositoryIds: (state.loadedRepositoryIds ?? []).filter(
			(repositoryId) => visibleIds.has(repositoryId),
		),
		loadedRepositoryFileIds: (state.loadedRepositoryFileIds ?? []).filter(
			(repositoryId) => visibleIds.has(repositoryId),
		),
		loadedRepositoryReadmeIds: (state.loadedRepositoryReadmeIds ?? []).filter(
			(repositoryId) => visibleIds.has(repositoryId),
		),
		loadedPullRequestFileIds: (state.loadedPullRequestFileIds ?? []).filter(
			(pullRequestId) =>
				[...visibleIds].some((repositoryId) =>
					pullRequestId.startsWith(`${repositoryId}:pull:`),
				),
		),
		loadedThreadIds: (state.loadedThreadIds ?? []).filter((threadId) =>
			visibleThreadIds.has(threadId),
		),
		users: visibleUsersForActor(state, actor, visibleIds),
		backupCredentials: {},
	} satisfies AppState
}

function visibleUsersForActor(
	state: AppState,
	actor: Actor,
	visibleIds: Set<string>,
) {
	const emails = new Set<string>()
	if (actor.role !== "anonymous") emails.add(actor.email.toLowerCase())
	for (const repository of state.repositories) {
		if (!visibleIds.has(repository.id)) continue
		for (const maintainer of repository.maintainers) {
			emails.add(maintainer.email.toLowerCase())
		}
		for (const grant of repository.access ?? []) {
			emails.add(grant.email.toLowerCase())
		}
		for (const issue of state.issues[repository.id] ?? []) {
			emails.add(issue.authorEmail.toLowerCase())
			for (const comment of issue.comments) {
				emails.add(comment.authorEmail.toLowerCase())
			}
		}
		for (const pullRequest of state.pullRequests[repository.id] ?? []) {
			emails.add(pullRequest.authorEmail.toLowerCase())
			if (pullRequest.reviewedBy)
				emails.add(pullRequest.reviewedBy.toLowerCase())
			for (const comment of pullRequest.comments) {
				emails.add(comment.authorEmail.toLowerCase())
			}
		}
	}
	for (const record of state.activity) {
		if (visibleIds.has(record.repositoryId)) {
			emails.add(record.actorEmail.toLowerCase())
		}
	}
	if (actor.role !== "anonymous") {
		for (const notification of state.notifications[actor.email.toLowerCase()] ??
			[]) {
			if (!visibleIds.has(notification.repositoryId)) continue
			emails.add(notification.actorEmail.toLowerCase())
			emails.add(notification.recipientEmail.toLowerCase())
		}
	}
	return Object.fromEntries(
		Object.entries(state.users).filter(([email]) =>
			emails.has(email.toLowerCase()),
		),
	)
}

function requireVisibleRepository(
	state: AppState,
	repositoryId: string,
	actor: Actor,
) {
	const repository = state.repositories.find((repo) => repo.id === repositoryId)
	if (!repository || !canSeeRepository(repository, actor)) {
		throw new Error("Repository not found.")
	}
	return repository
}

async function runRepositoryWrite(
	actor: Actor,
	repositoryId: string,
	repositoryRootFolderId: string | undefined,
	operation: string,
	loadOptions: {
		issueNumber?: number
		pullRequestNumber?: number
		includeIssueThreadDetails?: boolean
		includePullRequestThreadDetails?: boolean
	} | null,
	mutate: (accessToken: string, state: AppState) => Promise<AppState>,
	options: { includeDriveQuota?: boolean } = {},
) {
	let lastError: unknown
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const accessToken = await timed(
			"mutation.token",
			() => ownerDriveAccessToken(),
			{ operation, repositoryId, attempt: attempt + 1 },
		)
		const state = await timedWithBreakdown(
			"mutation.repository.load",
			() =>
				loadOrCreateAppState(accessToken, actor.email, {
					repositoryIds: [repositoryId],
					repositoryHints: repositoryHints({
						repositoryId,
						repositoryRootFolderId,
					}),
					includeIssueThreadDetails: Boolean(
						loadOptions?.includeIssueThreadDetails,
					),
					includePullRequestThreadDetails: Boolean(
						loadOptions?.includePullRequestThreadDetails,
					),
					issueNumbers: loadOptions?.issueNumber
						? [loadOptions.issueNumber]
						: undefined,
					pullRequestNumbers: loadOptions?.pullRequestNumber
						? [loadOptions.pullRequestNumber]
						: undefined,
				}),
			({ result }) => ({
				operation,
				repositoryId,
				attempt: attempt + 1,
				repositories: result?.repositories.length,
				loadedRepositoryIds: result?.loadedRepositoryIds?.length,
				issues: result?.issues[repositoryId]?.length,
				pullRequests: result?.pullRequests[repositoryId]?.length,
			}),
		)
		try {
			requireVisibleRepository(state, repositoryId, actor)
			const nextState = await timedWithBreakdown(
				"mutation.repository.write",
				() => mutate(accessToken, state),
				({ result }) => ({
					operation,
					repositoryId,
					attempt: attempt + 1,
					issues: result?.issues[repositoryId]?.length,
					pullRequests: result?.pullRequests[repositoryId]?.length,
				}),
			)
			syncBackupsInBackground(accessToken, actor.email, nextState)
			return visibleStateForActor(
				options.includeDriveQuota
					? await stateWithDriveStorageQuota(accessToken, nextState)
					: nextState,
				actor,
			)
		} catch (cause) {
			lastError = cause
			if (!isStorageConflict(cause)) throw cause
		}
	}
	throw lastError instanceof Error ? lastError : new Error("Write failed.")
}

type RepositoryWriteData = {
	repositoryId: string
	repositoryRootFolderId?: string
}

type RepositoryWriteLoadOptions = Parameters<typeof runRepositoryWrite>[4]

function repositoryWriteHandler<TData extends RepositoryWriteData>(
	operation: string,
	loadOptions: (data: TData) => RepositoryWriteLoadOptions,
	mutate: (input: {
		accessToken: string
		state: AppState
		actor: Actor
		data: TData
	}) => Promise<AppState>,
	options: { includeDriveQuota?: boolean } = {},
) {
	return async ({ data }: { data: TData }) => {
		const { actor } = await requireSession()
		return await runRepositoryWrite(
			actor,
			data.repositoryId,
			data.repositoryRootFolderId,
			operation,
			loadOptions(data),
			async (accessToken, state) =>
				await mutate({ accessToken, state, actor, data }),
			options,
		)
	}
}

function isStorageConflict(cause: unknown) {
	return (
		cause instanceof Error &&
		(cause.message.includes("Storage conflict detected") ||
			cause.message.includes("Repository storage conflict detected"))
	)
}

async function visibleBackgroundBackupWriteState(
	ownerAccessToken: string,
	state: AppState,
	actor: Actor,
	options: { includeDriveQuota?: boolean } = {},
) {
	syncBackupsInBackground(ownerAccessToken, actor.email, state)
	return visibleStateForActor(
		options.includeDriveQuota
			? await stateWithDriveStorageQuota(ownerAccessToken, state)
			: state,
		actor,
	)
}

function syncBackupsInBackground(
	ownerAccessToken: string,
	actorEmail: string,
	state: AppState,
) {
	if (!hasDueBackupSync(state)) return
	void timed("backup.sync", async () => {
		const latestState = await loadOrCreateAppState(
			ownerAccessToken,
			actorEmail,
			{
				includeIssueThreadDetails: true,
				includePullRequestThreadDetails: true,
			},
		)
		if (!hasDueBackupSync(latestState)) return
		await syncConnectedBackupDrives({
			ownerAccessToken,
			state: latestState,
			actorEmail,
			resolveBackupAccessToken: refreshGoogleAccessToken,
		})
	}).catch(() => undefined)
}

async function verifyGoogleIdentityToken(idToken: string) {
	const response = await fetch(
		`${GOOGLE_AUTH.tokenInfoUrl}?id_token=${encodeURIComponent(idToken)}`,
	)
	if (!response.ok) throw new Error("Google identity verification failed.")
	const data = (await response.json()) as {
		sub?: string
		email?: string
		email_verified?: string | boolean
		aud?: string
	}
	const expectedAudience = googleClientId()
	if (expectedAudience && data.aud !== expectedAudience) {
		throw new Error("Google identity token audience mismatch.")
	}
	if (!data.sub || !data.email)
		throw new Error("Google identity token is missing identity data.")
	if (data.email_verified !== true && data.email_verified !== "true") {
		throw new Error("Google account email is not verified.")
	}
	return {
		id: data.sub,
		email: data.email,
		role: roleForEmail(data.email),
	}
}

export const getAuthConfig = createServerFn({ method: "GET" }).handler(
	async () => ({
		googleClientId: googleClientId(),
	}),
)

export const getSessionState = createServerFn({ method: "GET" }).handler(
	async () => {
		const session = await getAppSession()
		const user = session.data.user
		if (!user) return { user: null }
		const refreshedUser = { ...user, role: roleForEmail(user.email) }
		await updateSession(getSessionConfig(), { user: refreshedUser })
		return { user: refreshedUser }
	},
)

export const getDriveState = createServerFn({ method: "GET" }).handler(
	async () => {
		const actor = await optionalActor()
		const accessToken = await ownerDriveAccessToken()
		const state = await loadOrCreateAppState(
			accessToken,
			actor.role === "anonymous" ? "" : actor.email,
			{ includeRepositoryDetails: false },
		)
		return visibleStateForActor(
			await stateWithDriveStorageQuota(accessToken, state),
			actor,
		)
	},
)

export const getRepositoryDriveState = createServerFn({ method: "GET" })
	.inputValidator(
		z.object({
			repositoryId: z.string().min(1),
			repositoryRootFolderId: repositoryRootFolderIdSchema,
			issueNumber: z.number().int().positive().optional(),
			pullRequestNumber: z.number().int().positive().optional(),
		}),
	)
	.handler(async ({ data }) => {
		const actor = await optionalActor()
		const state = await loadStateForUser(
			actor.role === "anonymous" ? undefined : actor.email,
			{
				repositoryIds: [data.repositoryId],
				repositoryHints: repositoryHints(data),
				issueNumbers: data.issueNumber ? [data.issueNumber] : undefined,
				pullRequestNumbers: data.pullRequestNumber
					? [data.pullRequestNumber]
					: undefined,
			},
		)
		requireVisibleRepository(state, data.repositoryId, actor)
		return visibleStateForActor(state, actor)
	})

export const loginWithGoogle = createServerFn({ method: "POST" })
	.inputValidator(
		z.object({
			code: z.string().min(1),
			redirectUri: z.string().url(),
		}),
	)
	.handler(async ({ data }) => {
		const auth = await exchangeGoogleAuthorizationCode(
			data.code,
			data.redirectUri,
		)
		if (!auth.id_token) {
			throw new Error("Google authorization returned no identity token.")
		}
		const user = await verifyGoogleIdentityToken(auth.id_token)
		await updateSession(getSessionConfig(), { user })
		return { user }
	})

export const logoutSession = createServerFn({ method: "POST" }).handler(
	async () => {
		await clearSession(getSessionConfig())
		return { ok: true }
	},
)

export const connectOwnerDriveServer = createServerFn({ method: "POST" })
	.inputValidator(
		z.object({
			code: z.string().min(1),
			redirectUri: z.string().url(),
		}),
	)
	.handler(async ({ data }) => {
		const { actor } = await requireSession()
		requireAdmin(actor)
		const ownerAuth = await exchangeBackupDriveCode(data.code, data.redirectUri)
		process.env[APP_ENV.googleDriveRefreshToken] = ownerAuth.refreshToken
		const state = await loadOrCreateAppState(
			ownerAuth.accessToken,
			actor.email,
			{ includeRepositoryDetails: false },
		)
		if (process.env.NODE_ENV !== "production") {
			await persistLocalEnvValue(
				APP_ENV.googleDriveRefreshToken,
				ownerAuth.refreshToken,
			)
			return {
				persisted: true,
				accountEmail: ownerAuth.accountEmail,
				state: visibleStateForActor(
					await stateWithDriveStorageQuota(ownerAuth.accessToken, state),
					actor,
				),
			}
		}
		return {
			persisted: false,
			accountEmail: ownerAuth.accountEmail,
			state: visibleStateForActor(
				await stateWithDriveStorageQuota(ownerAuth.accessToken, state),
				actor,
			),
			message: `Owner Drive connected for this server instance. Persist ${APP_ENV.googleDriveRefreshToken} in your production server environment to keep it after redeploy.`,
		}
	})

export const beginZipUploadServer = createServerFn({ method: "POST" })
	.inputValidator((input: unknown) => beginZipUploadInputSchema.parse(input))
	.handler(async ({ data }) => {
		const { actor } = await requireSession()
		const accessToken = await ownerDriveAccessToken()
		assertRequestOrigin(data.origin)
		if (data.kind === "repository") {
			requireAdmin(actor)
			const state = await loadOrCreateAppState(accessToken, actor.email, {
				includeRepositoryDetails: false,
			})
			const ownerName =
				state.users[actor.email.toLowerCase()]?.ownerName ??
				state.settings.ownerName
			void sweepStaleZipUploadFolders({ accessToken, state }).catch(
				() => undefined,
			)
			const upload = await beginRepositoryArchiveUpload({
				accessToken,
				state,
				owner: ownerName,
				name: data.name.trim(),
				zipBytes: data.zipBytes,
				origin: data.origin,
			})
			return {
				...upload,
				uploadTicket: signZipUploadTicket({
					kind: "repository",
					actorEmail: actor.email,
					owner: ownerName,
					name: data.name.trim(),
					uploadFolderId: upload.repositoryRootFolderId,
					zipBytes: data.zipBytes,
					origin: data.origin,
					expiresAt: Date.now() + APP_UPLOAD.zipUploadTicketTtlMs,
				}),
			}
		}
		const { state, repository } = await loadVisibleRepositoryState(
			actor,
			data.repositoryId,
			{
				repositoryRootFolderId: data.repositoryRootFolderId,
				pullRequestNumbers:
					data.kind === "pull-merge" ? [data.pullRequestNumber] : undefined,
			},
		)
		void sweepStaleZipUploadFolders({ accessToken, state }).catch(
			() => undefined,
		)
		if (data.kind === "pull-request") {
			const upload = await beginPullRequestArchiveUpload({
				accessToken,
				state,
				repository,
				baseRepositoryZipFileId: data.baseRepositoryZipFileId,
				zipBytes: data.zipBytes,
				origin: data.origin,
			})
			return {
				...upload,
				uploadTicket: signZipUploadTicket({
					kind: "pull-request",
					actorEmail: actor.email,
					repositoryId: repository.id,
					repositoryRootFolderId: repository.rootFolderId,
					uploadFolderId: upload.uploadFolderId,
					baseRepositoryZipFileId: data.baseRepositoryZipFileId,
					zipBytes: data.zipBytes,
					origin: data.origin,
					expiresAt: Date.now() + APP_UPLOAD.zipUploadTicketTtlMs,
				}),
			}
		}
		if (data.kind === "github-mirror-sync") {
			requireAdmin(actor)
			const upload = await beginGitHubMirrorSyncArchiveUpload({
				accessToken,
				state,
				repository,
				baseRepositoryZipFileId: data.baseRepositoryZipFileId,
				zipBytes: data.zipBytes,
				origin: data.origin,
			})
			return {
				...upload,
				uploadTicket: signZipUploadTicket({
					kind: "github-mirror-sync",
					actorEmail: actor.email,
					repositoryId: repository.id,
					repositoryRootFolderId: repository.rootFolderId,
					uploadFolderId: upload.uploadFolderId,
					baseRepositoryZipFileId: data.baseRepositoryZipFileId,
					zipBytes: data.zipBytes,
					origin: data.origin,
					expiresAt: Date.now() + APP_UPLOAD.zipUploadTicketTtlMs,
				}),
			}
		}
		const pullRequest = state.pullRequests[repository.id]?.find(
			(candidate) => candidate.number === data.pullRequestNumber,
		)
		if (!pullRequest) throw new Error("Pull request not found.")
		assertCanMergePullRequest(actor, repository, pullRequest)
		const upload = await beginMergedRepositoryArchiveUpload({
			accessToken,
			state,
			repository,
			baseRepositoryZipFileId: data.baseRepositoryZipFileId,
			zipBytes: data.zipBytes,
			origin: data.origin,
		})
		return {
			...upload,
			uploadTicket: signZipUploadTicket({
				kind: "pull-merge",
				actorEmail: actor.email,
				repositoryId: repository.id,
				repositoryRootFolderId: repository.rootFolderId,
				pullRequestNumber: data.pullRequestNumber,
				uploadFolderId: upload.uploadFolderId,
				baseRepositoryZipFileId: data.baseRepositoryZipFileId,
				zipBytes: data.zipBytes,
				origin: data.origin,
				expiresAt: Date.now() + APP_UPLOAD.zipUploadTicketTtlMs,
			}),
		}
	})

export const completeRepositoryUploadServer = createServerFn({ method: "POST" })
	.inputValidator((input: unknown) =>
		completeRepositoryUploadInputSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { actor } = await requireSession()
		requireAdmin(actor)
		const ticket = verifyZipUploadTicket(data.uploadTicket)
		if (
			ticket.kind !== "repository" ||
			ticket.actorEmail.toLowerCase() !== actor.email.toLowerCase() ||
			ticket.name !== data.name.trim()
		) {
			throw new Error("Repository upload ticket does not match this request.")
		}
		const accessToken = await ownerDriveAccessToken()
		const state = await loadOrCreateAppState(accessToken, actor.email, {
			includeRepositoryDetails: false,
		})
		return await visibleBackgroundBackupWriteState(
			accessToken,
			await completeRepositoryArchiveUpload({
				accessToken,
				state,
				actorEmail: actor.email,
				owner: ticket.owner,
				name: data.name.trim(),
				description: data.description,
				repositoryRootFolderId: ticket.uploadFolderId,
				repositoryZipFileId: data.repositoryZipFileId,
				repositoryZipBytes: ticket.zipBytes,
				files: data.files,
				githubMirror: data.githubMirror,
			}),
			actor,
			{ includeDriveQuota: true },
		)
	})

export const cancelZipUploadServer = createServerFn({ method: "POST" })
	.inputValidator((input: unknown) => cancelZipUploadInputSchema.parse(input))
	.handler(async ({ data }) => {
		const { actor } = await requireSession()
		const ticket = verifyZipUploadTicket(data.uploadTicket)
		if (ticket.actorEmail.toLowerCase() !== actor.email.toLowerCase()) {
			throw new Error("ZIP upload ticket does not match this request.")
		}
		const accessToken = await ownerDriveAccessToken()
		await cancelZipArchiveUpload({
			accessToken,
			uploadFolderId: ticket.uploadFolderId,
		})
		return { ok: true }
	})

export const completeGitHubMirrorSyncUploadServer = createServerFn({
	method: "POST",
})
	.inputValidator((input: unknown) =>
		completeGitHubMirrorSyncUploadInputSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { actor } = await requireSession()
		requireAdmin(actor)
		const ticket = verifyZipUploadTicket(data.uploadTicket)
		if (
			ticket.kind !== "github-mirror-sync" ||
			ticket.actorEmail.toLowerCase() !== actor.email.toLowerCase() ||
			ticket.repositoryId !== data.repositoryId ||
			(data.repositoryRootFolderId &&
				ticket.repositoryRootFolderId !== data.repositoryRootFolderId)
		) {
			throw new Error(
				"GitHub mirror upload ticket does not match this request.",
			)
		}
		return await runRepositoryWrite(
			actor,
			ticket.repositoryId,
			ticket.repositoryRootFolderId,
			"github.mirror.sync",
			null,
			async (accessToken, state) =>
				await completeGitHubMirrorSyncUploadInDriveState({
					accessToken,
					state,
					actorEmail: actor.email,
					repositoryId: ticket.repositoryId,
					uploadFolderId: ticket.uploadFolderId,
					repositoryZipFileId: data.repositoryZipFileId,
					repositoryZipBytes: ticket.zipBytes,
					baseRepositoryZipFileId: ticket.baseRepositoryZipFileId,
					files: data.files,
					githubMirror: data.githubMirror,
				}),
			{ includeDriveQuota: true },
		)
	})

export const watchRepositoryServer = createServerFn({ method: "POST" })
	.inputValidator(
		z.object({ repositoryId: z.string().min(1), watched: z.boolean() }),
	)
	.handler(async ({ data }) => {
		const { actor } = await requireSession()
		const accessToken = await ownerDriveAccessToken()
		const state = await loadOrCreateAppState(accessToken, actor.email, {
			includeRepositoryDetails: false,
		})
		requireVisibleRepository(state, data.repositoryId, actor)
		return await visibleBackgroundBackupWriteState(
			accessToken,
			await setRepositoryWatch({
				accessToken,
				state,
				actorEmail: actor.email,
				repositoryId: data.repositoryId,
				watched: data.watched,
			}),
			actor,
		)
	})

export const markNotificationsReadServer = createServerFn({
	method: "POST",
}).handler(async () => {
	const { actor } = await requireSession()
	const accessToken = await ownerDriveAccessToken()
	return await visibleStateForActor(
		await markNotificationsReadInDriveState({
			accessToken,
			state: await loadOrCreateAppState(accessToken, actor.email, {
				includeRepositoryDetails: false,
			}),
			actorEmail: actor.email,
		}),
		actor,
	)
})

export const deleteRepositoryServer = createServerFn({ method: "POST" })
	.inputValidator(z.object({ repositoryId: z.string().min(1) }))
	.handler(async ({ data }) => {
		const { actor } = await requireSession()
		requireAdmin(actor)
		const accessToken = await ownerDriveAccessToken()
		return await visibleBackgroundBackupWriteState(
			accessToken,
			await deleteRepositoryFromDrive({
				accessToken,
				state: await loadOrCreateAppState(accessToken, actor.email, {
					includeRepositoryDetails: false,
				}),
				actorEmail: actor.email,
				repositoryId: data.repositoryId,
			}),
			actor,
			{ includeDriveQuota: true },
		)
	})

export const updateSettingsServer = createServerFn({ method: "POST" })
	.inputValidator((data) => appSettingsSchema.parse(data))
	.handler(async ({ data }) => {
		const { actor } = await requireSession()
		requireAdmin(actor)
		const accessToken = await ownerDriveAccessToken()
		return await visibleBackgroundBackupWriteState(
			accessToken,
			await updateAppSettings({
				accessToken,
				state: await loadOrCreateAppState(accessToken, actor.email, {
					includeRepositoryDetails: false,
				}),
				actorEmail: actor.email,
				settings: data,
			}),
			actor,
		)
	})

export const updateUserNameServer = createServerFn({ method: "POST" })
	.inputValidator(z.object({ ownerName: z.string().min(1) }))
	.handler(async ({ data }) => {
		const { actor } = await requireSession()
		const accessToken = await ownerDriveAccessToken()
		return await visibleBackgroundBackupWriteState(
			accessToken,
			await updateUserNameInDriveState({
				accessToken,
				state: await loadOrCreateAppState(accessToken, actor.email, {
					includeIssueThreadDetails: true,
					includePullRequestThreadDetails: true,
				}),
				actorEmail: actor.email,
				ownerName: data.ownerName,
			}),
			actor,
		)
	})

export const connectBackupDriveServer = createServerFn({ method: "POST" })
	.inputValidator(
		z.object({
			code: z.string().min(1),
			redirectUri: z.string().url(),
		}),
	)
	.handler(async ({ data }) => {
		const { actor } = await requireSession()
		requireAdmin(actor)
		const ownerAccessToken = await ownerDriveAccessToken()
		const state = await loadOrCreateAppState(ownerAccessToken, actor.email, {
			includeIssueThreadDetails: true,
			includePullRequestThreadDetails: true,
		})
		const backupAuth = await exchangeBackupDriveCode(
			data.code,
			data.redirectUri,
		)
		return visibleStateForActor(
			await connectBackupDrive({
				ownerAccessToken,
				state,
				actorEmail: actor.email,
				backupAccessToken: backupAuth.accessToken,
				backupRefreshToken: backupAuth.refreshToken,
				accountEmail: backupAuth.accountEmail,
			}),
			actor,
		)
	})

export const disconnectBackupDriveServer = createServerFn({ method: "POST" })
	.inputValidator(z.object({ targetId: z.string().min(1) }))
	.handler(async ({ data }) => {
		const { actor } = await requireSession()
		requireAdmin(actor)
		const accessToken = await ownerDriveAccessToken()
		return await visibleBackgroundBackupWriteState(
			accessToken,
			await disconnectBackupDrive({
				accessToken,
				state: await loadOrCreateAppState(accessToken, actor.email, {
					includeRepositoryDetails: false,
				}),
				actorEmail: actor.email,
				targetId: data.targetId,
			}),
			actor,
		)
	})

export const deleteBackupDriveServer = createServerFn({ method: "POST" })
	.inputValidator(z.object({ targetId: z.string().min(1) }))
	.handler(async ({ data }) => {
		const { actor } = await requireSession()
		requireAdmin(actor)
		const ownerAccessToken = await ownerDriveAccessToken()
		const state = await loadOrCreateAppState(ownerAccessToken, actor.email, {
			includeRepositoryDetails: false,
		})
		const target = state.settings.backupTargets.find(
			(candidate) => candidate.id === data.targetId,
		)
		if (!target) throw new Error("Backup Drive not found.")
		const credential = state.backupCredentials[target.credentialRef]
		if (!credential) throw new Error("Backup Drive credential not found.")
		return await visibleBackgroundBackupWriteState(
			ownerAccessToken,
			await deleteBackupDrive({
				ownerAccessToken,
				state,
				actorEmail: actor.email,
				targetId: data.targetId,
				backupAccessToken: await refreshGoogleAccessToken(
					credential.refreshToken,
				),
			}),
			actor,
		)
	})

export const updateRepositoryAccessServer = createServerFn({ method: "POST" })
	.inputValidator(
		z.object({
			repositoryId: z.string().min(1),
			repositoryRootFolderId: repositoryRootFolderIdSchema,
			name: z.string().min(1).optional(),
			description: z.string().optional(),
			visibility: z.enum(["public", "private"]),
			policy: repositoryPolicySchema,
			accessEmails: z.array(z.string()),
		}),
	)
	.handler(async ({ data }) => {
		const { actor } = await requireSession()
		const accessToken = await ownerDriveAccessToken()
		return await visibleBackgroundBackupWriteState(
			accessToken,
			await updateRepositoryAccessInDriveState({
				accessToken,
				state: await loadOrCreateAppState(accessToken, actor.email, {
					repositoryIds: [data.repositoryId],
					repositoryHints: repositoryHints(data),
					includeIssueThreadDetails: true,
					includePullRequestThreadDetails: true,
				}),
				actor,
				...data,
			}),
			actor,
		)
	})

export const createIssueServer = createServerFn({ method: "POST" })
	.inputValidator(
		z.object({
			repositoryId: z.string().min(1),
			repositoryRootFolderId: repositoryRootFolderIdSchema,
			title: z.string().min(1),
			body: z.string().min(1),
			labels: z.array(z.string()),
		}),
	)
	.handler(
		repositoryWriteHandler(
			"issue.create",
			() => null,
			({ accessToken, state, actor, data }) =>
				createIssueInDriveState({
					accessToken,
					state,
					actorEmail: actor.email,
					...data,
				}),
		),
	)

export const commentOnIssueServer = createServerFn({ method: "POST" })
	.inputValidator(
		z.object({
			repositoryId: z.string().min(1),
			repositoryRootFolderId: repositoryRootFolderIdSchema,
			issueNumber: z.number().int().positive(),
			body: z.string().min(1),
		}),
	)
	.handler(
		repositoryWriteHandler(
			"issue.comment",
			(data) => ({ issueNumber: data.issueNumber }),
			({ accessToken, state, actor, data }) =>
				commentOnIssueInDriveState({
					accessToken,
					state,
					actorEmail: actor.email,
					...data,
				}),
		),
	)

export const editIssueTitleServer = createServerFn({ method: "POST" })
	.inputValidator(
		z.object({
			repositoryId: z.string().min(1),
			repositoryRootFolderId: repositoryRootFolderIdSchema,
			issueNumber: z.number().int().positive(),
			title: z.string().min(1),
		}),
	)
	.handler(
		repositoryWriteHandler(
			"issue.title.edit",
			(data) => ({ issueNumber: data.issueNumber }),
			({ accessToken, state, actor, data }) =>
				editIssueTitleInDriveState({
					accessToken,
					state,
					actor,
					...data,
				}),
		),
	)

export const editIssueMessageServer = createServerFn({ method: "POST" })
	.inputValidator(
		z.object({
			repositoryId: z.string().min(1),
			repositoryRootFolderId: repositoryRootFolderIdSchema,
			issueNumber: z.number().int().positive(),
			messageId: z.string().min(1),
			body: z.string().min(1),
		}),
	)
	.handler(
		repositoryWriteHandler(
			"issue.message.edit",
			(data) => ({ issueNumber: data.issueNumber }),
			({ accessToken, state, actor, data }) =>
				editIssueMessageInDriveState({
					accessToken,
					state,
					actor,
					...data,
				}),
		),
	)

export const transitionIssueServer = createServerFn({ method: "POST" })
	.inputValidator(
		z.object({
			repositoryId: z.string().min(1),
			repositoryRootFolderId: repositoryRootFolderIdSchema,
			issueNumber: z.number().int().positive(),
			nextIssueState: issueStateSchema,
		}),
	)
	.handler(
		repositoryWriteHandler(
			"issue.state.change",
			(data) => ({ issueNumber: data.issueNumber }),
			({ accessToken, state, actor, data }) =>
				transitionIssueInDriveState({
					accessToken,
					state,
					actor,
					repositoryId: data.repositoryId,
					issueNumber: data.issueNumber,
					nextIssueState: data.nextIssueState as IssueState,
				}),
		),
	)

export const completePullRequestUploadServer = createServerFn({
	method: "POST",
})
	.inputValidator((input: unknown) =>
		completePullRequestUploadInputSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { actor } = await requireSession()
		const ticket = verifyZipUploadTicket(data.uploadTicket)
		if (
			ticket.kind !== "pull-request" ||
			ticket.actorEmail.toLowerCase() !== actor.email.toLowerCase() ||
			ticket.repositoryId !== data.repositoryId ||
			(data.repositoryRootFolderId &&
				ticket.repositoryRootFolderId !== data.repositoryRootFolderId)
		) {
			throw new Error("Pull request upload ticket does not match this request.")
		}
		return await runRepositoryWrite(
			actor,
			ticket.repositoryId,
			ticket.repositoryRootFolderId,
			"pull.create",
			null,
			async (accessToken, state) =>
				await completePullRequestArchiveUpload({
					accessToken,
					state,
					actorEmail: actor.email,
					repositoryId: ticket.repositoryId,
					title: data.title,
					body: data.body,
					uploadFolderId: ticket.uploadFolderId,
					uploadZipFileId: data.uploadZipFileId,
					uploadZipBytes: ticket.zipBytes,
					baseRepositoryZipFileId: ticket.baseRepositoryZipFileId,
					files: data.files,
					baseFiles: data.baseFiles,
					diff: data.diff,
				}),
			{ includeDriveQuota: true },
		)
	})

export const commentOnPullRequestServer = createServerFn({ method: "POST" })
	.inputValidator(
		z.object({
			repositoryId: z.string().min(1),
			repositoryRootFolderId: repositoryRootFolderIdSchema,
			pullRequestNumber: z.number().int().positive(),
			body: z.string().min(1),
		}),
	)
	.handler(
		repositoryWriteHandler(
			"pull.comment",
			(data) => ({ pullRequestNumber: data.pullRequestNumber }),
			({ accessToken, state, actor, data }) =>
				commentOnPullRequestInDriveState({
					accessToken,
					state,
					actorEmail: actor.email,
					...data,
				}),
		),
	)

export const editPullRequestTitleServer = createServerFn({ method: "POST" })
	.inputValidator(
		z.object({
			repositoryId: z.string().min(1),
			repositoryRootFolderId: repositoryRootFolderIdSchema,
			pullRequestNumber: z.number().int().positive(),
			title: z.string().min(1),
		}),
	)
	.handler(
		repositoryWriteHandler(
			"pull.title.edit",
			(data) => ({ pullRequestNumber: data.pullRequestNumber }),
			({ accessToken, state, actor, data }) =>
				editPullRequestTitleInDriveState({
					accessToken,
					state,
					actor,
					...data,
				}),
		),
	)

export const editPullRequestMessageServer = createServerFn({ method: "POST" })
	.inputValidator(
		z.object({
			repositoryId: z.string().min(1),
			repositoryRootFolderId: repositoryRootFolderIdSchema,
			pullRequestNumber: z.number().int().positive(),
			messageId: z.string().min(1),
			body: z.string().min(1),
		}),
	)
	.handler(
		repositoryWriteHandler(
			"pull.message.edit",
			(data) => ({ pullRequestNumber: data.pullRequestNumber }),
			({ accessToken, state, actor, data }) =>
				editPullRequestMessageInDriveState({
					accessToken,
					state,
					actor,
					...data,
				}),
		),
	)

export const reviewPullRequestServer = createServerFn({ method: "POST" })
	.inputValidator(
		z.object({
			repositoryId: z.string().min(1),
			repositoryRootFolderId: repositoryRootFolderIdSchema,
			pullRequestNumber: z.number().int().positive(),
		}),
	)
	.handler(
		repositoryWriteHandler(
			"pull.review",
			(data) => ({ pullRequestNumber: data.pullRequestNumber }),
			({ accessToken, state, actor, data }) =>
				reviewPullRequestInDriveState({
					accessToken,
					state,
					actor,
					...data,
				}),
		),
	)

export const closePullRequestServer = createServerFn({ method: "POST" })
	.inputValidator(
		z.object({
			repositoryId: z.string().min(1),
			repositoryRootFolderId: repositoryRootFolderIdSchema,
			pullRequestNumber: z.number().int().positive(),
		}),
	)
	.handler(
		repositoryWriteHandler(
			"pull.close",
			(data) => ({ pullRequestNumber: data.pullRequestNumber }),
			({ accessToken, state, actor, data }) =>
				closePullRequestInDriveState({
					accessToken,
					state,
					actor,
					...data,
				}),
		),
	)

export const mergePullRequestServer = createServerFn({ method: "POST" })
	.inputValidator((input: unknown) =>
		completePullRequestMergeUploadInputSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { actor } = await requireSession()
		const ticket = verifyZipUploadTicket(data.uploadTicket)
		if (
			ticket.kind !== "pull-merge" ||
			ticket.actorEmail.toLowerCase() !== actor.email.toLowerCase() ||
			ticket.repositoryId !== data.repositoryId ||
			ticket.pullRequestNumber !== data.pullRequestNumber ||
			(data.repositoryRootFolderId &&
				ticket.repositoryRootFolderId !== data.repositoryRootFolderId)
		) {
			throw new Error("Merge upload ticket does not match this request.")
		}
		return await runRepositoryWrite(
			actor,
			ticket.repositoryId,
			ticket.repositoryRootFolderId,
			"pull.merge",
			{
				pullRequestNumber: data.pullRequestNumber,
				includePullRequestThreadDetails: true,
			},
			async (accessToken, state) =>
				await completePullRequestMergeUploadInDriveState({
					accessToken,
					state,
					actor,
					repositoryId: ticket.repositoryId,
					pullRequestNumber: ticket.pullRequestNumber,
					uploadFolderId: ticket.uploadFolderId,
					repositoryZipFileId: data.repositoryZipFileId,
					repositoryZipBytes: ticket.zipBytes,
					baseRepositoryZipFileId: ticket.baseRepositoryZipFileId,
					files: data.files,
				}),
			{ includeDriveQuota: true },
		)
	})

export const createRepositoryZipDownloadLinkServer = createServerFn({
	method: "POST",
})
	.inputValidator(
		z.object({
			repositoryId: z.string().min(1),
			repositoryRootFolderId: repositoryRootFolderIdSchema,
		}),
	)
	.handler(async ({ data }) => {
		const actor = await optionalActor()
		const { state } = await loadVisibleRepositoryState(
			actor,
			data.repositoryId,
			{
				repositoryRootFolderId: data.repositoryRootFolderId,
			},
		)
		const link = await createRepositoryZipDownloadLink({
			accessToken: await ownerDriveAccessToken(),
			state,
			repositoryId: data.repositoryId,
			browserApiKey: googleDriveBrowserApiKey(),
		})
		return zipDownloadPayload(actor, link, state.settings.downloadCleanupDelayMs)
	})

export const createPullRequestZipDownloadLinkServer = createServerFn({
	method: "POST",
})
	.inputValidator(
		z.object({
			repositoryId: z.string().min(1),
			repositoryRootFolderId: repositoryRootFolderIdSchema,
			pullRequestNumber: z.number().int().positive(),
		}),
	)
	.handler(async ({ data }) => {
		const actor = await optionalActor()
		const { state } = await loadVisibleRepositoryState(
			actor,
			data.repositoryId,
			{
				repositoryRootFolderId: data.repositoryRootFolderId,
				pullRequestNumbers: [data.pullRequestNumber],
			},
		)
		const link = await createPullRequestZipDownloadLink({
			accessToken: await ownerDriveAccessToken(),
			state,
			repositoryId: data.repositoryId,
			pullRequestNumber: data.pullRequestNumber,
			browserApiKey: googleDriveBrowserApiKey(),
		})
		return zipDownloadPayload(actor, link, state.settings.downloadCleanupDelayMs)
	})

export const revokeZipDownloadLinkServer = createServerFn({ method: "POST" })
	.inputValidator(revokeZipDownloadInputSchema)
	.handler(async ({ data }) => {
		const ticket = verifyZipDownloadTicket(data.downloadTicket)
		await revokeZipDownloadLink({
			accessToken: await ownerDriveAccessToken(),
			fileId: ticket.fileId,
			folderId: ticket.folderId,
			permissionId: ticket.permissionId,
		})
		return { ok: true }
	})
