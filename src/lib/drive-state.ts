import {
	APP_DOWNLOAD,
	APP_NAME,
	APP_SCHEMA,
	APP_STORAGE,
	APP_TIMING,
	APP_UPLOAD,
} from "./app-config"
import { canMaintainRepository, canOwnRepository } from "./auth"
import type { ActivityRecord } from "./activity"
import type { Actor } from "./types"
import {
	createGoogleDriveFile,
	createGoogleDriveFolder,
	createGoogleDriveUploadSession,
	createGoogleDriveAnyoneReaderPermission,
	copyGoogleDriveFile,
	deleteGoogleDriveFile,
	deleteGoogleDriveFileByName,
	deleteGoogleDrivePermission,
	deleteGoogleDriveAppDataDocument,
	ensureGoogleDriveResultsFolder,
	downloadGoogleDriveFile,
	getGoogleDriveFileMetadata,
	getGoogleDriveStorageQuota,
	googleDrivePublicFileMediaUrl,
	GoogleDriveConflictError,
	listGoogleDriveChildFoldersByPrefix,
	loadGoogleDriveAppDataDocument,
	loadGoogleDriveFileByName,
	loadGoogleDriveFilesByPrefix,
	moveGoogleDriveFile,
	saveGoogleDriveAppDataDocument,
	saveGoogleDriveFileByName,
	uploadFileToGoogleDrive,
	type GoogleDriveFile,
	type GoogleDriveStorageQuota,
} from "./google-drive"
import {
	assertIssueLabels,
	extractMentions,
	transitionIssueState,
	type IssueRecord,
	type IssueState,
} from "./issues"
import {
	assertCanMergePullRequest,
	type FileDiff,
	type PullRequestRecord,
} from "./pulls"
import { assertRepositoryName, createRepositoryManifest } from "./repositories"
import {
	prepareRepositoryUploadMetadata,
	type UploadedRepositoryFileMetadata,
} from "./repositories/uploads"
import { assertRepositoryContentPath } from "./security/paths"
import { createBootstrapConfig, createDefaultSettings } from "./settings"
import type {
	AppSettings,
	BackupDriveCredential,
	BackupDriveTarget,
	RepositoryAccessGrant,
	RepositoryFile,
	RepositoryManifest,
	RepositoryPolicy,
} from "./types"
import { appSettingsSchema } from "./types"
import { timed } from "./timing"

type ThreadComment = {
	id: string
	authorEmail: string
	body: string
	createdAt: string
	updatedAt?: string
	editedAt?: string
}

type AppPullRequest = PullRequestRecord & {
	files: RepositoryFile[]
	baseFiles: RepositoryFile[]
	diff: FileDiff[]
	comments: ThreadComment[]
}

export type RepositorySnapshot = {
	revision: string
	sha256: string
	archiveBytes: number
	driveFileId: string
	createdAt: string
	source: "repository.created" | "repository.synced" | "pull_request.merged"
	pullRequestNumber?: number
}

export type IntegrationEvent = {
	cursor: number
	id: string
	type: "repository.snapshot"
	repositoryId: string
	revision: string
	createdAt: string
}

export type AppState = {
	schema: typeof APP_SCHEMA.state
	storageVersion?: string
	repositoryStorageVersions?: Record<string, string | undefined>
	loadedRepositoryIds?: string[]
	loadedRepositoryFileIds?: string[]
	loadedRepositoryReadmeIds?: string[]
	loadedPullRequestFileIds?: string[]
	loadedThreadIds?: string[]
	config: ReturnType<typeof createBootstrapConfig>
	settings: ReturnType<typeof createDefaultSettings>
	rootFolder: GoogleDriveFile
	driveStorageQuota?: GoogleDriveStorageQuota
	repositories: RepositoryManifest[]
	repositoryFiles: Record<string, RepositoryFile[]>
	repositoryReadmeFiles: Record<string, RepositoryFile[]>
	repositoryZipFileIds: Record<string, string>
	repositorySnapshots: Record<string, RepositorySnapshot[]>
	integrationEvents: IntegrationEvent[]
	integrationNextCursor: number
	issues: Record<string, IssueRecord[]>
	pullRequests: Record<string, AppPullRequest[]>
	pullRequestZipFileIds: Record<string, string>
	watches: Record<string, string[]>
	users: Record<string, UserProfile>
	notifications: Record<string, AppNotification[]>
	activity: ActivityRecord[]
	backupCredentials: Record<string, BackupDriveCredential>
}

export type UserProfile = {
	email: string
	ownerName: string
	createdAt: string
	updatedAt: string
}

type AppNotification = {
	id: string
	repositoryId: string
	recipientEmail: string
	actorEmail: string
	sourceId: string
	message: string
	createdAt: string
	read: boolean
}

export type UploadProgress = {
	phase: "preparing" | "zipping" | "uploading"
	current: number
	total: number
	message: string
}

type StoredAppState = Partial<AppState> & {
	schema: typeof APP_SCHEMA.state
	rootFolder: GoogleDriveFile
}

type StoredRepositoryFile = Omit<RepositoryFile, "content" | "encoding"> & {
	content?: RepositoryFile["content"]
	encoding?: RepositoryFile["encoding"]
}

type StoredAppPullRequest = PullRequestRecord & {
	files: StoredRepositoryFile[]
	baseFiles?: StoredRepositoryFile[]
	diff: FileDiff[]
	comments: ThreadComment[]
}

type StoredRepositoryState = {
	schema: typeof APP_SCHEMA.repositoryState
	repositoryId: string
	repositoryFiles: StoredRepositoryFile[]
	readmeFiles?: StoredRepositoryFile[]
	repositoryZipFileId?: string
	issues: IssueRecord[]
	pullRequests: StoredAppPullRequest[]
	pullRequestZipFileIds: Record<string, string>
	activity: ActivityRecord[]
}

type StoredRepositoryThread = {
	schema: typeof APP_SCHEMA.repositoryThread
	repositoryId: string
	kind: "issue" | "pull"
	thread: IssueRecord | StoredAppPullRequest
}

type MaterializedRepositoryStateInput = Omit<
	StoredRepositoryState,
	"schema" | "repositoryId" | "repositoryFiles" | "pullRequests"
> & {
	repositoryFiles: RepositoryFile[]
	readmeFiles: RepositoryFile[]
	pullRequests: AppPullRequest[]
	notifications: Record<string, AppNotification[]>
	storageVersion?: string
	loadedThreadIds?: string[]
}

type StoredRepositoryAppendRecord = {
	schema: typeof APP_SCHEMA.repositoryAppend
	id: string
	repositoryId: string
	createdAt: string
	kind:
		| "issue.created"
		| "pull.created"
		| "issue.commented"
		| "issue.title.edited"
		| "issue.message.edited"
		| "issue.state.changed"
		| "pull.commented"
		| "pull.title.edited"
		| "pull.message.edited"
		| "pull.reviewed"
		| "pull.closed"
	issue?: IssueRecord
	pullRequest?: StoredAppPullRequest
	targetId?: string
	comment?: ThreadComment
	title?: string
	body?: string
	messageId?: string
	issueState?: IssueState
	reviewedBy?: string
	pullRequestZipFileId?: string
	activity: ActivityRecord[]
	notifications: Record<string, AppNotification[]>
}

type LoadedRepositoryAppendRecord = StoredRepositoryAppendRecord & {
	fileId: string
}

type RepositoryLoadHint = {
	repositoryId: string
	rootFolderId: string
}

type LoadAppStateOptions = {
	includeRepositoryDetails?: boolean
	repositoryIds?: string[]
	repositoryHints?: RepositoryLoadHint[]
	includeIssueThreadDetails?: boolean
	includePullRequestThreadDetails?: boolean
	issueNumbers?: number[]
	pullRequestNumbers?: number[]
}

type RepositoryStateDocumentParts = {
	existing: Awaited<ReturnType<typeof loadRepositoryStateFile>>
	appendRecords: LoadedRepositoryAppendRecord[]
}

type PreloadedRepositoryStateDocument = {
	rootFolderId: string
	promise: Promise<RepositoryStateDocumentParts | { error: unknown }>
}

export async function loadOrCreateAppState(
	accessToken: string,
	actorEmail: string,
	options: LoadAppStateOptions = {},
) {
	const preloadedRepositoryDocuments = preloadRepositoryStateDocuments(
		accessToken,
		options,
	)
	const existing = await timed(
		"drive.appdata.global.load",
		() => loadGoogleDriveAppDataDocument(accessToken),
		({ result }) => ({
			found: Boolean(result),
			version: result?.file.version,
			bytes: result?.raw.length,
			includeRepositoryDetails: options.includeRepositoryDetails,
			repositoryIds: options.repositoryIds?.length,
		}),
	)
	if (existing?.raw) {
		let parsed: StoredAppState
		try {
			parsed = JSON.parse(existing.raw) as StoredAppState
		} catch {
			throw new Error("Harbur app data is unreadable.")
		}
		if (parsed?.schema === APP_SCHEMA.state) {
			const parsedSettings = appSettingsSchema.safeParse(parsed.settings)
			if (parsed.rootFolder?.id && parsed.config && parsedSettings.success) {
				const rootFolder = parsed.rootFolder
				const state: AppState = {
					schema: APP_SCHEMA.state,
					storageVersion: existing.file.version,
					config: {
						...parsed.config,
						publicReposFolderId: rootFolder.id,
						publicReposFolderUrl: rootFolder.webViewLink ?? "",
					},
					settings: parsedSettings.data,
					rootFolder,
					repositories: parsed.repositories ?? [],
					repositoryFiles: {},
					repositoryReadmeFiles: {},
					repositoryZipFileIds: {},
					repositorySnapshots: parsed.repositorySnapshots ?? {},
					integrationEvents: parsed.integrationEvents ?? [],
					integrationNextCursor: parsed.integrationNextCursor ?? 1,
					issues: {},
					pullRequests: {},
					pullRequestZipFileIds: {},
					watches: parsed.watches ?? {},
					users: parsed.users ?? {},
					notifications: parsed.notifications ?? {},
					activity: parsed.activity ?? [],
					backupCredentials: parsed.backupCredentials ?? {},
					repositoryStorageVersions: {},
					loadedRepositoryIds: [],
					loadedRepositoryFileIds: [],
					loadedRepositoryReadmeIds: [],
					loadedPullRequestFileIds: [],
					loadedThreadIds: [],
				}
				const requestedRepositoryIds =
					options.repositoryIds ??
					(options.includeRepositoryDetails === false
						? []
						: state.repositories.map((repository) => repository.id))
				let hydratedState = state
				if (requestedRepositoryIds.length) {
					hydratedState = await loadRepositoryDetailsForState(
						accessToken,
						hydratedState,
						requestedRepositoryIds,
						Boolean(options.includeIssueThreadDetails),
						Boolean(options.includePullRequestThreadDetails),
						options.issueNumbers,
						options.pullRequestNumbers,
						preloadedRepositoryDocuments,
					)
				}
				const registeredState = ensureUserProfile(
					hydratedState,
					actorEmail,
					new Date().toISOString(),
				)
				if (registeredState !== hydratedState) {
					await saveAppState(accessToken, registeredState)
				}
				return registeredState
			}
		}
		throw new Error("Harbur app data is incompatible with this version.")
	}

	const rootFolder = await ensureAppRootFolder(accessToken)
	const state: AppState = {
		schema: APP_SCHEMA.state,
		config: createBootstrapConfig(rootFolder.id, rootFolder.webViewLink ?? ""),
		settings: createDefaultSettings(actorEmail),
		rootFolder,
		repositories: [],
		repositoryFiles: {},
		repositoryReadmeFiles: {},
		repositoryZipFileIds: {},
		repositorySnapshots: {},
		integrationEvents: [],
		integrationNextCursor: 1,
		issues: {},
		pullRequests: {},
		pullRequestZipFileIds: {},
		watches: {},
		users: {},
		notifications: {},
		activity: [],
		backupCredentials: {},
		repositoryStorageVersions: {},
		loadedRepositoryIds: [],
		loadedRepositoryFileIds: [],
		loadedRepositoryReadmeIds: [],
		loadedPullRequestFileIds: [],
		loadedThreadIds: [],
	}
	const registeredState = ensureUserProfile(
		state,
		actorEmail,
		new Date().toISOString(),
	)
	await saveAppState(accessToken, registeredState)
	return registeredState
}

async function ensureAppRootFolder(accessToken: string) {
	return await timed(
		"drive.root.ensure",
		() => ensureGoogleDriveResultsFolder(accessToken),
		({ result }) => ({
			rootFolderId: result?.id,
			rootFolderName: result?.name,
		}),
	)
}

export async function stateWithDriveStorageQuota(
	accessToken: string,
	state: AppState,
) {
	try {
		return {
			...state,
			driveStorageQuota: await getGoogleDriveStorageQuota(accessToken),
		}
	} catch {
		return state
	}
}

async function assertDriveQuotaForZipUpload(
	accessToken: string,
	zipBytes: number,
) {
	const quota = await getGoogleDriveStorageQuota(accessToken).catch(() => null)
	const limit = quotaBytes(quota?.limit)
	const usage = quotaBytes(quota?.usage)
	if (limit === null || usage === null) return
	const remaining = limit - usage
	const required = zipBytes + APP_UPLOAD.driveQuotaSafetyBytes
	if (remaining < required) {
		throw new Error(
			`Owner Drive has ${remaining} bytes available; this upload needs ${required} bytes including safety margin.`,
		)
	}
}

function quotaBytes(value: string | undefined) {
	if (!value) return null
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : null
}

async function saveAppState(accessToken: string, state: AppState) {
	try {
		const saved = await timed(
			"drive.appdata.global.save",
			() =>
				saveGoogleDriveAppDataDocument(
					accessToken,
					JSON.stringify(
						{
							schema: state.schema,
							config: state.config,
							settings: state.settings,
							rootFolder: state.rootFolder,
							repositories: state.repositories,
							repositorySnapshots: state.repositorySnapshots,
							integrationEvents: state.integrationEvents,
							integrationNextCursor: state.integrationNextCursor,
							watches: state.watches,
							users: state.users,
							notifications: state.notifications,
							activity: globalActivityRecords(state),
							backupCredentials: state.backupCredentials,
						},
						null,
						2,
					),
					state.storageVersion,
				),
			{ repositories: state.repositories.length },
		)
		state.storageVersion = saved.version
	} catch (error) {
		if (error instanceof GoogleDriveConflictError) {
			throw new Error(
				"Storage conflict detected. Refresh the page and try the change again.",
			)
		}
		throw error
	}
}

function repositoryStateFileName(
	repository: Pick<RepositoryManifest, "rootFolderId">,
) {
	return `${APP_SCHEMA.repositoryState}.${repository.rootFolderId}.json`
}

function repositoryThreadFileName(
	repository: Pick<RepositoryManifest, "rootFolderId">,
	threadId: string,
) {
	return `${repositoryThreadFilePrefix(repository)}${threadStorageKey(threadId)}.json`
}

function repositoryThreadFilePrefix(
	repository: Pick<RepositoryManifest, "rootFolderId">,
) {
	return `${APP_SCHEMA.repositoryThread}.${repository.rootFolderId}.`
}

function repositoryAppendFilePrefix(
	repository: Pick<RepositoryManifest, "rootFolderId">,
) {
	return `${APP_SCHEMA.repositoryAppend}.${repository.rootFolderId}.`
}

function repositoryAppendFileName(
	repository: Pick<RepositoryManifest, "rootFolderId">,
	recordId: string,
) {
	return `${repositoryAppendFilePrefix(repository)}${recordId}.json`
}

function globalActivityRecords(state: AppState) {
	const repositoryIds = new Set(
		state.repositories.map((repository) => repository.id),
	)
	return state.activity.filter(
		(record) => !repositoryIds.has(record.repositoryId),
	)
}

function preloadRepositoryStateDocuments(
	accessToken: string,
	options: LoadAppStateOptions,
) {
	const repositoryIds = options.repositoryIds ?? []
	if (!repositoryIds.length || !options.repositoryHints?.length) {
		return new Map<string, PreloadedRepositoryStateDocument>()
	}

	const hints = new Map(
		options.repositoryHints.map((hint) => [
			hint.repositoryId,
			hint.rootFolderId,
		]),
	)
	const preloaded = new Map<string, PreloadedRepositoryStateDocument>()
	for (const repositoryId of repositoryIds) {
		const rootFolderId = hints.get(repositoryId)
		if (!rootFolderId) continue
		const repository = {
			id: repositoryId,
			rootFolderId,
		} as RepositoryManifest
		preloaded.set(repositoryId, {
			rootFolderId,
			promise: loadRepositoryStateDocumentParts(accessToken, repository).catch(
				(error: unknown) => ({ error }),
			),
		})
	}
	return preloaded
}

async function loadRepositoryDetailsForState(
	accessToken: string,
	state: AppState,
	repositoryIds: string[],
	includeIssueThreadDetails: boolean,
	includePullRequestThreadDetails: boolean,
	issueNumbers?: number[],
	pullRequestNumbers?: number[],
	preloadedRepositoryDocuments = new Map<
		string,
		PreloadedRepositoryStateDocument
	>(),
) {
	const requestedIds = new Set(repositoryIds)
	let nextState: AppState = {
		...state,
		loadedRepositoryIds: [
			...(state.loadedRepositoryIds ?? []).filter(
				(repositoryId) => !requestedIds.has(repositoryId),
			),
		],
		loadedRepositoryFileIds: [
			...(state.loadedRepositoryFileIds ?? []).filter(
				(repositoryId) => !requestedIds.has(repositoryId),
			),
		],
		loadedRepositoryReadmeIds: [
			...(state.loadedRepositoryReadmeIds ?? []).filter(
				(repositoryId) => !requestedIds.has(repositoryId),
			),
		],
		loadedPullRequestFileIds: [
			...(state.loadedPullRequestFileIds ?? []).filter(
				(pullRequestId) =>
					![...requestedIds].some((repositoryId) =>
						pullRequestId.startsWith(`${repositoryId}:pull:`),
					),
			),
		],
		loadedThreadIds: [
			...(state.loadedThreadIds ?? []).filter(
				(threadId) =>
					![...requestedIds].some((repositoryId) =>
						threadId.startsWith(`${repositoryId}:`),
					),
			),
		],
		activity: state.activity.filter(
			(record) => !requestedIds.has(record.repositoryId),
		),
	}
	for (const repository of state.repositories) {
		if (!requestedIds.has(repository.id)) continue
		const repositoryState = await loadRepositoryStateDocument(
			accessToken,
			repository,
			state.settings.prAutoCleanDays,
			includeIssueThreadDetails,
			includePullRequestThreadDetails,
			issueNumbers,
			pullRequestNumbers,
			preloadedRepositoryDocuments.get(repository.id),
		)
		nextState = mergeMaterializedRepositoryState(
			nextState,
			repository.id,
			repositoryState,
			false,
			false,
		)
	}
	return nextState
}

async function loadRepositoryStateDocument(
	accessToken: string,
	repository: RepositoryManifest,
	prAutoCleanDays: number,
	includeIssueThreadDetails: boolean,
	includePullRequestThreadDetails: boolean,
	issueNumbers?: number[],
	pullRequestNumbers?: number[],
	preloaded?: PreloadedRepositoryStateDocument,
) {
	const parts =
		preloaded?.rootFolderId === repository.rootFolderId
			? await preloaded.promise
			: await loadRepositoryStateDocumentParts(accessToken, repository)
	if ("error" in parts) {
		throw parts.error
	}
	return await materializeRepositoryStateDocument({
		accessToken,
		repository,
		prAutoCleanDays,
		includeIssueThreadDetails,
		includePullRequestThreadDetails,
		issueNumbers,
		pullRequestNumbers,
		...parts,
	})
}

async function loadRepositoryStateDocumentParts(
	accessToken: string,
	repository: Pick<RepositoryManifest, "id" | "rootFolderId">,
): Promise<RepositoryStateDocumentParts> {
	const [existing, driveAppendRecords] = await Promise.all([
		timed(
			"drive.repository.state.load",
			() => loadRepositoryStateFile(accessToken, repository),
			({ result }) => ({
				repositoryId: repository.id,
				found: Boolean(result),
				version: result?.file.version,
			}),
		),
		timed(
			"drive.repository.append.load",
			() => loadRepositoryAppendRecords(accessToken, repository),
			({ result }) => ({
				repositoryId: repository.id,
				appendRecords: result?.length ?? 0,
			}),
		),
	])
	return { existing, appendRecords: driveAppendRecords }
}

async function materializeRepositoryStateDocument({
	accessToken,
	repository,
	prAutoCleanDays,
	includeIssueThreadDetails,
	includePullRequestThreadDetails,
	issueNumbers,
	pullRequestNumbers,
	existing,
	appendRecords,
}: {
	accessToken: string
	repository: RepositoryManifest
	prAutoCleanDays: number
	includeIssueThreadDetails: boolean
	includePullRequestThreadDetails: boolean
	issueNumbers?: number[]
	pullRequestNumbers?: number[]
	existing: RepositoryStateDocumentParts["existing"]
	appendRecords: LoadedRepositoryAppendRecord[]
}) {
	if (existing?.raw) {
		try {
			const parsed = JSON.parse(existing.raw) as Partial<StoredRepositoryState>
			if (parsed.schema === APP_SCHEMA.repositoryState) {
				let materializedState = await timed(
					"drive.repository.materialize",
					async () => {
						return materializeRepositoryState({
							repositoryId: repository.id,
							base: {
								repositoryFiles: [],
								readmeFiles: storedRepositoryFilesWithContent(
									parsed.readmeFiles,
								),
								repositoryZipFileId: parsed.repositoryZipFileId,
								issues: parsed.issues ?? [],
								pullRequests: storedPullRequestsForRuntime(
									parsed.pullRequests ?? [],
								),
								pullRequestZipFileIds: parsed.pullRequestZipFileIds ?? {},
								activity: parsed.activity ?? [],
								notifications: {},
								storageVersion: existing.file.version,
							},
							appendRecords,
						})
					},
					({ result }) => ({
						repositoryId: repository.id,
						appendRecords: appendRecords.length,
						repositoryFiles: result?.repositoryFiles.length ?? 0,
						issues: result?.issues.length ?? 0,
						pullRequests: result?.pullRequests.length ?? 0,
					}),
				)
				if (
					shouldHydrateRepositoryThreads({
						includeIssueThreadDetails,
						includePullRequestThreadDetails,
						issueNumbers,
						pullRequestNumbers,
					})
				) {
					const detailedBaseState = await hydrateRepositoryThreadDetails({
						accessToken,
						repository,
						state: materializedState,
						includeIssueThreadDetails,
						includePullRequestThreadDetails,
						issueNumbers,
						pullRequestNumbers,
					})
					materializedState = await timed(
						"drive.repository.thread.materialize",
						() =>
							Promise.resolve(
								materializeRepositoryState({
									repositoryId: repository.id,
									base: detailedBaseState,
									appendRecords,
								}),
							),
						({ result }) => ({
							repositoryId: repository.id,
							loadedThreadIds: result?.loadedThreadIds?.length ?? 0,
						}),
					)
				}
				materializedState = await compactRepositoryAppendRecords({
					accessToken,
					repository,
					state: materializedState,
					appendRecords,
				})
				const finalState = await timed(
					"drive.repository.prune",
					() =>
						pruneExpiredPullRequests({
							accessToken,
							repository,
							state: materializedState,
							appendRecords,
							prAutoCleanDays,
						}),
					({ result }) => ({
						repositoryId: repository.id,
						prAutoCleanDays,
						pullRequests: result?.pullRequests.length ?? 0,
					}),
				)
				return finalState
			}
		} catch {
			throw new Error(`Repository state is unreadable: ${repository.id}`)
		}
		throw new Error(`Repository state is unreadable: ${repository.id}`)
	}
	throw new Error(`Repository state is missing: ${repository.id}`)
}

async function loadRepositoryStateFile(
	accessToken: string,
	repository: Pick<RepositoryManifest, "rootFolderId">,
) {
	return await loadGoogleDriveFileByName(
		accessToken,
		repository.rootFolderId,
		repositoryStateFileName(repository),
	)
}

async function loadRepositoryThreadDocument(
	accessToken: string,
	repository: RepositoryManifest,
	threadId: string,
) {
	const existing = await timed(
		"drive.repository.thread.load",
		() =>
			loadGoogleDriveFileByName(
				accessToken,
				repository.rootFolderId,
				repositoryThreadFileName(repository, threadId),
			),
		({ result }) => ({
			repositoryId: repository.id,
			threadId,
			found: Boolean(result),
			version: result?.file.version,
		}),
	)
	if (!existing?.raw) return null
	const parsed = JSON.parse(existing.raw) as Partial<StoredRepositoryThread>
	if (
		parsed.schema !== APP_SCHEMA.repositoryThread ||
		parsed.repositoryId !== repository.id ||
		!parsed.thread
	) {
		throw new Error(`Repository thread is unreadable: ${threadId}`)
	}
	if (parsed.kind === "issue") {
		return parsed.thread as IssueRecord
	}
	if (parsed.kind === "pull") {
		return storedPullRequestForRuntime(parsed.thread as StoredAppPullRequest)
	}
	throw new Error(`Repository thread is unreadable: ${threadId}`)
}

async function saveRepositoryThreadDocument(
	accessToken: string,
	repository: RepositoryManifest,
	thread: IssueRecord | AppPullRequest,
) {
	const kind = thread.id.includes(":issue:") ? "issue" : "pull"
	const storedThread =
		kind === "pull" ? pullRequestForStorage(thread as AppPullRequest) : thread
	const raw = JSON.stringify(
		{
			schema: APP_SCHEMA.repositoryThread,
			repositoryId: repository.id,
			kind,
			thread: storedThread,
		} satisfies StoredRepositoryThread,
		null,
		2,
	)
	return await timed(
		"drive.repository.thread.save",
		() =>
			saveGoogleDriveFileByName({
				accessToken,
				parentId: repository.rootFolderId,
				name: repositoryThreadFileName(repository, thread.id),
				raw,
			}),
		{
			repositoryId: repository.id,
			threadId: thread.id,
			kind,
			bytes: new Blob([raw]).size,
		},
	)
}

async function deleteRepositoryThreadDocument(
	accessToken: string,
	repository: RepositoryManifest,
	threadId: string,
) {
	await deleteGoogleDriveFileByName(
		accessToken,
		repository.rootFolderId,
		repositoryThreadFileName(repository, threadId),
	).catch(() => undefined)
}

async function saveLoadedRepositoryThreadDocuments(
	accessToken: string,
	repository: RepositoryManifest,
	state: Pick<AppState, "issues" | "pullRequests" | "loadedThreadIds">,
) {
	const loadedThreadIds = new Set(state.loadedThreadIds ?? [])
	const issues = state.issues[repository.id] ?? []
	const pullRequests = state.pullRequests[repository.id] ?? []
	await Promise.all([
		...issues
			.filter((issue) => loadedThreadIds.has(issue.id))
			.map((issue) =>
				saveRepositoryThreadDocument(accessToken, repository, issue),
			),
		...pullRequests
			.filter((pullRequest) => loadedThreadIds.has(pullRequest.id))
			.map((pullRequest) =>
				saveRepositoryThreadDocument(accessToken, repository, pullRequest),
			),
	])
}

async function hydrateRepositoryThreadDetails({
	accessToken,
	repository,
	state,
	includeIssueThreadDetails = false,
	includePullRequestThreadDetails = false,
	issueNumbers,
	pullRequestNumbers,
	threadIds,
}: {
	accessToken: string
	repository: RepositoryManifest
	state: MaterializedRepositoryStateInput
	includeIssueThreadDetails?: boolean
	includePullRequestThreadDetails?: boolean
	issueNumbers?: number[]
	pullRequestNumbers?: number[]
	threadIds?: Set<string>
}): Promise<MaterializedRepositoryStateInput> {
	const requestedIssueNumbers = issueNumbers?.length
		? new Set(issueNumbers)
		: null
	const requestedPullRequestNumbers = pullRequestNumbers?.length
		? new Set(pullRequestNumbers)
		: null
	const selectedIssueIds = state.issues
		.filter(
			(issue) =>
				includeIssueThreadDetails ||
				requestedIssueNumbers?.has(issue.number) ||
				threadIds?.has(issue.id),
		)
		.map((issue) => issue.id)
	const selectedPullRequestIds = state.pullRequests
		.filter(
			(pullRequest) =>
				includePullRequestThreadDetails ||
				requestedPullRequestNumbers?.has(pullRequest.number) ||
				threadIds?.has(pullRequest.id),
		)
		.map((pullRequest) => pullRequest.id)
	const selectedIds = [...selectedIssueIds, ...selectedPullRequestIds]
	if (!selectedIds.length) return state

	const loadedEntries = await Promise.all(
		selectedIds.map(async (threadId) => [
			threadId,
			await loadRepositoryThreadDocument(accessToken, repository, threadId),
		]),
	)
	const loadedThreads = new Map(
		loadedEntries.filter(
			(entry): entry is [string, IssueRecord | AppPullRequest] =>
				Boolean(entry[1]),
		),
	)
	const loadedThreadIds = [
		...new Set([...(state.loadedThreadIds ?? []), ...selectedIds]),
	]
	if (!loadedThreads.size) {
		return {
			...state,
			loadedThreadIds,
		}
	}

	return {
		...state,
		issues: state.issues.map((issue) => {
			const loaded = loadedThreads.get(issue.id)
			return loaded?.id.includes(":issue:") ? (loaded as IssueRecord) : issue
		}),
		pullRequests: state.pullRequests.map((pullRequest) => {
			const loaded = loadedThreads.get(pullRequest.id)
			return loaded?.id.includes(":pull:")
				? (loaded as AppPullRequest)
				: pullRequest
		}),
		loadedThreadIds,
	}
}

function shouldHydrateRepositoryThreads({
	includeIssueThreadDetails,
	includePullRequestThreadDetails,
	issueNumbers,
	pullRequestNumbers,
}: {
	includeIssueThreadDetails: boolean
	includePullRequestThreadDetails: boolean
	issueNumbers?: number[]
	pullRequestNumbers?: number[]
}) {
	return Boolean(
		includeIssueThreadDetails ||
			includePullRequestThreadDetails ||
			issueNumbers?.length ||
			pullRequestNumbers?.length,
	)
}

function storedRepositoryFilesWithContent(
	files: StoredRepositoryFile[] | undefined,
) {
	return (files ?? [])
		.filter(
			(file): file is StoredRepositoryFile & Pick<RepositoryFile, "content"> =>
				file.content !== undefined,
		)
		.map(
			(file) =>
				({
					path: file.path,
					content: file.content,
					encoding: file.encoding,
					size: file.size,
					contentHash: file.contentHash,
					modifiedAt: file.modifiedAt,
				}) satisfies RepositoryFile,
		)
}

function repositoryReadmeFilesForStorage(
	files: RepositoryFile[],
): StoredRepositoryFile[] {
	const readme = files.find((file) => isRootReadmePath(file.path))
	const assets: StoredRepositoryFile[] = []
	let assetBytes = 0
	for (const file of files) {
		if (!isReadmeAssetPath(file.path)) continue
		if (assets.length >= APP_STORAGE.readmeAssetMaxFiles) break
		if (assetBytes + file.size > APP_STORAGE.readmeAssetMaxBytes) continue
		assetBytes += file.size
		assets.push(repositoryFileForSidecar(file))
	}
	return [...(readme ? [repositoryFileForSidecar(readme)] : []), ...assets]
}

function pullRequestBaseFilesForSidecar(files: RepositoryFile[]) {
	const baseFiles: RepositoryFile[] = []
	let bytes = 0
	for (const file of files) {
		if (baseFiles.length >= APP_STORAGE.pullRequestBaseSidecarMaxFiles) break
		if (bytes + file.size > APP_STORAGE.pullRequestBaseSidecarMaxBytes) {
			continue
		}
		bytes += file.size
		baseFiles.push(file)
	}
	return baseFiles
}

function repositoryFileForSidecar(file: RepositoryFile): StoredRepositoryFile {
	return {
		path: file.path,
		content: file.content,
		encoding: file.encoding,
		size: file.size,
		contentHash: file.contentHash,
		modifiedAt: file.modifiedAt,
	}
}

function isRootReadmePath(path: string) {
	return path.trim().replaceAll("\\", "/").toLowerCase() === "readme.md"
}

function isReadmeAssetPath(path: string) {
	const normalized = path.trim().replaceAll("\\", "/").toLowerCase()
	if (!normalized.startsWith("assets/")) return false
	return /\.(avif|gif|jpe?g|png|svg|webp)$/.test(normalized)
}

function storedPullRequestsForRuntime(
	pullRequests: StoredAppPullRequest[],
): AppPullRequest[] {
	return pullRequests.map(storedPullRequestForRuntime)
}

function storedPullRequestForRuntime(
	pullRequest: StoredAppPullRequest,
): AppPullRequest {
	return {
		...pullRequest,
		files: [],
		baseFiles: storedRepositoryFilesWithContent(pullRequest.baseFiles),
	}
}

async function loadRepositoryAppendRecords(
	accessToken: string,
	repository: Pick<RepositoryManifest, "id" | "rootFolderId">,
) {
	const documents = await loadGoogleDriveFilesByPrefix(
		accessToken,
		repository.rootFolderId,
		repositoryAppendFilePrefix(repository),
	)
	return documents
		.map((document) => {
			try {
				return {
					...(JSON.parse(
						document.raw,
					) as Partial<StoredRepositoryAppendRecord>),
					fileId: document.file.id,
				}
			} catch {
				return null
			}
		})
		.filter(
			(record): record is LoadedRepositoryAppendRecord =>
				record?.schema === APP_SCHEMA.repositoryAppend &&
				record.repositoryId === repository.id &&
				typeof record.id === "string" &&
				typeof record.fileId === "string" &&
				typeof record.createdAt === "string" &&
				Array.isArray(record.activity) &&
				typeof record.notifications === "object" &&
				record.notifications !== null &&
				isValidAppendRecordPayload(record),
		)
		.sort(compareAppendRecords)
}

function isValidAppendRecordPayload(
	record: Partial<StoredRepositoryAppendRecord>,
) {
	switch (record.kind) {
		case "issue.created":
			return Boolean(record.issue)
		case "pull.created":
			return Boolean(record.pullRequest)
		case "issue.commented":
		case "pull.commented":
			return Boolean(record.targetId && record.comment)
		case "issue.title.edited":
		case "pull.title.edited":
			return Boolean(record.targetId && record.title)
		case "issue.message.edited":
		case "pull.message.edited":
			return Boolean(record.targetId && record.messageId && record.body)
		case "issue.state.changed":
			return Boolean(
				record.targetId &&
					(record.issueState === "open" || record.issueState === "closed"),
			)
		case "pull.reviewed":
			return Boolean(record.targetId && record.reviewedBy)
		case "pull.closed":
			return Boolean(record.targetId)
		default:
			return false
	}
}

function materializeRepositoryState({
	repositoryId,
	base,
	appendRecords,
}: {
	repositoryId: string
	base: MaterializedRepositoryStateInput
	appendRecords: StoredRepositoryAppendRecord[]
}) {
	const issues = new Map(base.issues.map((issue) => [issue.id, issue]))
	const pullRequests = new Map(
		base.pullRequests.map((pullRequest) => [pullRequest.id, pullRequest]),
	)
	const pullRequestZipFileIds = { ...base.pullRequestZipFileIds }
	const activity = new Map(base.activity.map((record) => [record.id, record]))
	let notifications = { ...base.notifications }

	for (const record of appendRecords) {
		if (record.kind === "issue.created" && record.issue) {
			if (!issues.has(record.issue.id))
				issues.set(record.issue.id, record.issue)
		}
		if (record.kind === "pull.created" && record.pullRequest) {
			if (!pullRequests.has(record.pullRequest.id)) {
				pullRequests.set(
					record.pullRequest.id,
					storedPullRequestForRuntime(record.pullRequest),
				)
			}
			if (record.pullRequestZipFileId) {
				pullRequestZipFileIds[record.pullRequest.id] =
					record.pullRequestZipFileId
			}
		}
		if (
			record.kind === "issue.commented" &&
			record.targetId &&
			record.comment
		) {
			const issue = issues.get(record.targetId)
			if (
				issue &&
				!issue.comments.some((item) => item.id === record.comment?.id)
			) {
				issues.set(record.targetId, {
					...issue,
					comments: [...issue.comments, record.comment],
					updatedAt: maxTimestamp(issue.updatedAt, record.comment.createdAt),
				})
			}
		}
		if (
			record.kind === "issue.title.edited" &&
			record.targetId &&
			record.title
		) {
			const issue = issues.get(record.targetId)
			if (issue) {
				issues.set(record.targetId, {
					...issue,
					title: record.title,
					updatedAt: maxTimestamp(issue.updatedAt, record.createdAt),
				})
			}
		}
		if (
			record.kind === "issue.message.edited" &&
			record.targetId &&
			record.messageId &&
			record.body
		) {
			const issue = issues.get(record.targetId)
			if (issue) {
				const editedAt = record.createdAt
				const nextIssue =
					record.messageId === issue.id
						? {
								...issue,
								body: record.body,
								updatedAt: maxTimestamp(issue.updatedAt, editedAt),
								editedAt,
							}
						: {
								...issue,
								updatedAt: maxTimestamp(issue.updatedAt, editedAt),
								comments: issue.comments.map((comment) =>
									comment.id === record.messageId
										? {
												...comment,
												body: record.body ?? comment.body,
												updatedAt: editedAt,
												editedAt,
											}
										: comment,
								),
							}
				issues.set(record.targetId, nextIssue)
			}
		}
		if (
			record.kind === "issue.state.changed" &&
			record.targetId &&
			record.issueState
		) {
			const issue = issues.get(record.targetId)
			if (issue) {
				issues.set(record.targetId, {
					...issue,
					state: record.issueState,
					updatedAt: maxTimestamp(issue.updatedAt, record.createdAt),
				})
			}
		}
		if (record.kind === "pull.commented" && record.targetId && record.comment) {
			const pullRequest = pullRequests.get(record.targetId)
			if (
				pullRequest &&
				!pullRequest.comments.some((item) => item.id === record.comment?.id)
			) {
				pullRequests.set(record.targetId, {
					...pullRequest,
					comments: [...pullRequest.comments, record.comment],
					updatedAt: maxTimestamp(
						pullRequest.updatedAt,
						record.comment.createdAt,
					),
				})
			}
		}
		if (
			record.kind === "pull.title.edited" &&
			record.targetId &&
			record.title
		) {
			const pullRequest = pullRequests.get(record.targetId)
			if (pullRequest) {
				pullRequests.set(record.targetId, {
					...pullRequest,
					title: record.title,
					updatedAt: maxTimestamp(pullRequest.updatedAt, record.createdAt),
				})
			}
		}
		if (
			record.kind === "pull.message.edited" &&
			record.targetId &&
			record.messageId &&
			record.body
		) {
			const pullRequest = pullRequests.get(record.targetId)
			if (pullRequest) {
				const editedAt = record.createdAt
				const nextPullRequest =
					record.messageId === pullRequest.id
						? {
								...pullRequest,
								body: record.body,
								updatedAt: maxTimestamp(pullRequest.updatedAt, editedAt),
								editedAt,
							}
						: {
								...pullRequest,
								updatedAt: maxTimestamp(pullRequest.updatedAt, editedAt),
								comments: pullRequest.comments.map((comment) =>
									comment.id === record.messageId
										? {
												...comment,
												body: record.body ?? comment.body,
												updatedAt: editedAt,
												editedAt,
											}
										: comment,
								),
							}
				pullRequests.set(record.targetId, nextPullRequest)
			}
		}
		if (
			record.kind === "pull.reviewed" &&
			record.targetId &&
			record.reviewedBy
		) {
			const pullRequest = pullRequests.get(record.targetId)
			if (pullRequest && !pullRequest.reviewedBy) {
				pullRequests.set(record.targetId, {
					...pullRequest,
					reviewedBy: record.reviewedBy,
					updatedAt: maxTimestamp(pullRequest.updatedAt, record.createdAt),
				})
			}
		}
		if (record.kind === "pull.closed" && record.targetId) {
			const pullRequest = pullRequests.get(record.targetId)
			if (pullRequest?.state === "open") {
				pullRequests.set(record.targetId, {
					...pullRequest,
					state: "closed",
					updatedAt: maxTimestamp(pullRequest.updatedAt, record.createdAt),
				})
			}
		}
		for (const activityRecord of record.activity) {
			if (!activity.has(activityRecord.id)) {
				activity.set(activityRecord.id, activityRecord)
			}
		}
		notifications = mergeNotificationRecords(
			notifications,
			record.notifications,
		)
	}

	return {
		...base,
		issues: assignThreadNumbers([...issues.values()]),
		pullRequests: assignThreadNumbers([...pullRequests.values()]),
		loadedPullRequestFileIds: [] as string[],
		loadedThreadIds: base.loadedThreadIds ?? [],
		pullRequestZipFileIds: Object.fromEntries(
			Object.entries(pullRequestZipFileIds).filter(([pullRequestId]) =>
				pullRequestId.startsWith(`${repositoryId}:pull:`),
			),
		),
		activity: [...activity.values()].sort(compareActivityRecords),
		notifications,
	}
}

function materializeAppStateWithAppendRecord(
	state: AppState,
	repositoryId: string,
	appendRecord: StoredRepositoryAppendRecord,
) {
	const repositoryState = materializeRepositoryState({
		repositoryId,
		base: {
			repositoryFiles: state.repositoryFiles[repositoryId] ?? [],
			readmeFiles: state.repositoryReadmeFiles[repositoryId] ?? [],
			repositoryZipFileId: state.repositoryZipFileIds[repositoryId],
			issues: state.issues[repositoryId] ?? [],
			pullRequests: state.pullRequests[repositoryId] ?? [],
			pullRequestZipFileIds: state.pullRequestZipFileIds,
			activity: state.activity.filter(
				(record) => record.repositoryId === repositoryId,
			),
			notifications: state.notifications,
			storageVersion: state.repositoryStorageVersions?.[repositoryId],
			loadedThreadIds: [
				...new Set([
					...(state.loadedThreadIds ?? []),
					...(appendRecordThreadId(appendRecord)
						? [appendRecordThreadId(appendRecord) as string]
						: []),
				]),
			],
		},
		appendRecords: [appendRecord],
	})
	return mergeMaterializedRepositoryState(
		state,
		repositoryId,
		repositoryState,
		Boolean(state.loadedRepositoryFileIds?.includes(repositoryId)),
		false,
	)
}

function mergeMaterializedRepositoryState(
	state: AppState,
	repositoryId: string,
	repositoryState: ReturnType<typeof materializeRepositoryState>,
	repositoryFilesLoaded = true,
	pullRequestFilesLoaded = repositoryFilesLoaded,
): AppState {
	return {
		...state,
		repositoryFiles: repositoryFilesLoaded
			? {
					...state.repositoryFiles,
					[repositoryId]: repositoryState.repositoryFiles,
				}
			: state.repositoryFiles,
		repositoryReadmeFiles: {
			...state.repositoryReadmeFiles,
			[repositoryId]: repositoryState.readmeFiles,
		},
		repositoryZipFileIds: repositoryState.repositoryZipFileId
			? {
					...state.repositoryZipFileIds,
					[repositoryId]: repositoryState.repositoryZipFileId,
				}
			: omitRecordKey(state.repositoryZipFileIds, repositoryId),
		issues: {
			...state.issues,
			[repositoryId]: repositoryState.issues,
		},
		pullRequests: {
			...state.pullRequests,
			[repositoryId]: repositoryState.pullRequests,
		},
		pullRequestZipFileIds: {
			...Object.fromEntries(
				Object.entries(state.pullRequestZipFileIds).filter(
					([pullRequestId]) =>
						!pullRequestId.startsWith(`${repositoryId}:pull:`),
				),
			),
			...repositoryState.pullRequestZipFileIds,
		},
		activity: [
			...state.activity.filter(
				(record) => record.repositoryId !== repositoryId,
			),
			...repositoryState.activity,
		],
		notifications: mergeNotificationRecords(
			state.notifications,
			repositoryState.notifications,
		),
		repositoryStorageVersions: {
			...(state.repositoryStorageVersions ?? {}),
			...(repositoryState.storageVersion
				? { [repositoryId]: repositoryState.storageVersion }
				: {}),
		},
		loadedRepositoryIds: [
			...new Set([...(state.loadedRepositoryIds ?? []), repositoryId]),
		],
		loadedRepositoryFileIds: repositoryFilesLoaded
			? [...new Set([...(state.loadedRepositoryFileIds ?? []), repositoryId])]
			: state.loadedRepositoryFileIds,
		loadedRepositoryReadmeIds: [
			...new Set([...(state.loadedRepositoryReadmeIds ?? []), repositoryId]),
		],
		loadedPullRequestFileIds: pullRequestFilesLoaded
			? [
					...new Set([
						...(state.loadedPullRequestFileIds ?? []),
						...repositoryState.loadedPullRequestFileIds,
					]),
				]
			: state.loadedPullRequestFileIds,
		loadedThreadIds: [
			...new Set([
				...(state.loadedThreadIds ?? []),
				...(repositoryState.loadedThreadIds ?? []),
			]),
		],
	}
}

function maxTimestamp(left: string, right: string) {
	return left.localeCompare(right) >= 0 ? left : right
}

function threadStorageKey(threadId: string) {
	return threadId.split(":").at(-1) ?? threadId
}

function appendRecordThreadId(record: StoredRepositoryAppendRecord) {
	return record.issue?.id ?? record.pullRequest?.id ?? record.targetId
}

async function compactRepositoryAppendRecords({
	accessToken,
	repository,
	state,
	appendRecords,
}: {
	accessToken: string
	repository: RepositoryManifest
	state: ReturnType<typeof materializeRepositoryState>
	appendRecords: LoadedRepositoryAppendRecord[]
}) {
	const shouldCompact =
		appendRecords.length >= APP_STORAGE.repositoryAppendCompactionThreshold
	if (!shouldCompact) {
		return state
	}

	try {
		const affectedThreadIds = new Set(
			appendRecords
				.map(appendRecordThreadId)
				.filter((threadId): threadId is string => Boolean(threadId)),
		)
		const detailedBaseState = await hydrateRepositoryThreadDetails({
			accessToken,
			repository,
			state,
			threadIds: affectedThreadIds,
		})
		const detailedState = materializeRepositoryState({
			repositoryId: repository.id,
			base: {
				...detailedBaseState,
				loadedThreadIds: [
					...new Set([
						...(detailedBaseState.loadedThreadIds ?? []),
						...affectedThreadIds,
					]),
				],
			},
			appendRecords,
		})
		await saveLoadedRepositoryThreadDocuments(accessToken, repository, {
			issues: { [repository.id]: detailedState.issues },
			pullRequests: { [repository.id]: detailedState.pullRequests },
			loadedThreadIds: detailedState.loadedThreadIds,
		})
		const saved = await timed(
			"drive.repository.append.compact",
			() =>
				saveRepositoryStateDocument(accessToken, repository, {
					repositoryFiles: detailedState.repositoryFiles,
					readmeFiles: detailedState.readmeFiles,
					repositoryZipFileId: detailedState.repositoryZipFileId,
					issues: detailedState.issues,
					pullRequests: detailedState.pullRequests,
					pullRequestZipFileIds: detailedState.pullRequestZipFileIds,
					activity: detailedState.activity,
					storageVersion: detailedState.storageVersion,
					reason: "append.compact",
				}),
			{ repositoryId: repository.id, appendRecords: appendRecords.length },
		)
		const compactedState = { ...detailedState, storageVersion: saved.version }
		await deleteLoadedAppendRecords(accessToken, appendRecords)
		return compactedState
	} catch {
		return state
	}
}

async function pruneExpiredPullRequests({
	accessToken,
	repository,
	state,
	appendRecords,
	prAutoCleanDays,
}: {
	accessToken: string
	repository: RepositoryManifest
	state: ReturnType<typeof materializeRepositoryState>
	appendRecords: LoadedRepositoryAppendRecord[]
	prAutoCleanDays: number
}) {
	if (prAutoCleanDays <= 0) return state

	const cutoff = Date.now() - prAutoCleanDays * APP_TIMING.msPerDay
	const expiredIds = new Set(
		state.pullRequests
			.filter((pullRequest) => {
				const createdAt = Date.parse(pullRequest.createdAt)
				return Number.isFinite(createdAt) && createdAt < cutoff
			})
			.map((pullRequest) => pullRequest.id),
	)
	if (!expiredIds.size) return state

	const pullRequestZipFileIds = { ...state.pullRequestZipFileIds }
	const zipFileIdsToDelete = new Set<string>()
	for (const pullRequestId of expiredIds) {
		const zipFileId = pullRequestZipFileIds[pullRequestId]
		if (zipFileId) zipFileIdsToDelete.add(zipFileId)
		delete pullRequestZipFileIds[pullRequestId]
	}

	const appendRecordsToDelete = appendRecords.filter(
		(record) =>
			(record.kind === "pull.created" &&
				record.pullRequest &&
				expiredIds.has(record.pullRequest.id)) ||
			Boolean(record.targetId && expiredIds.has(record.targetId)),
	)
	for (const record of appendRecordsToDelete) {
		if (record.pullRequestZipFileId) {
			zipFileIdsToDelete.add(record.pullRequestZipFileId)
		}
	}

	const nextState = {
		...state,
		pullRequests: assignThreadNumbers(
			state.pullRequests.filter(
				(pullRequest) => !expiredIds.has(pullRequest.id),
			),
		),
		pullRequestZipFileIds,
		activity: state.activity.filter(
			(record) =>
				![...expiredIds].some((pullRequestId) =>
					record.id.startsWith(`${pullRequestId}:`),
				),
		),
	}

	try {
		const saved = await saveRepositoryStateDocument(accessToken, repository, {
			repositoryFiles: nextState.repositoryFiles,
			readmeFiles: nextState.readmeFiles,
			repositoryZipFileId: nextState.repositoryZipFileId,
			issues: nextState.issues,
			pullRequests: nextState.pullRequests,
			pullRequestZipFileIds: nextState.pullRequestZipFileIds,
			activity: nextState.activity,
			storageVersion: nextState.storageVersion,
			reason: "pull.autoclean",
		})
		nextState.storageVersion = saved.version
	} catch {
		return state
	}

	await Promise.all([
		deleteLoadedAppendRecords(accessToken, appendRecordsToDelete),
		...[...expiredIds].map((pullRequestId) =>
			deleteRepositoryThreadDocument(
				accessToken,
				repository,
				pullRequestId,
			).catch(() => undefined),
		),
		...[...zipFileIdsToDelete].map((zipFileId) =>
			deleteGoogleDriveFile(accessToken, zipFileId).catch(() => undefined),
		),
	])
	return nextState
}

async function deleteLoadedAppendRecords(
	accessToken: string,
	records: Array<LoadedRepositoryAppendRecord | StoredRepositoryAppendRecord>,
) {
	await Promise.all(
		records.map((record) => {
			const fileId = "fileId" in record ? record.fileId : undefined
			return fileId
				? deleteGoogleDriveFile(accessToken, fileId).catch(() => undefined)
				: Promise.resolve()
		}),
	)
}

function assignThreadNumbers<T extends { id: string; createdAt: string }>(
	records: T[],
) {
	return [...records]
		.sort(compareThreadRecords)
		.map((record, index) => ({ ...record, number: index + 1 }))
}

function compareThreadRecords(
	left: { id: string; createdAt: string },
	right: { id: string; createdAt: string },
) {
	return (
		left.createdAt.localeCompare(right.createdAt) ||
		left.id.localeCompare(right.id)
	)
}

function compareAppendRecords(
	left: StoredRepositoryAppendRecord,
	right: StoredRepositoryAppendRecord,
) {
	return compareThreadRecords(left, right)
}

function compareActivityRecords(left: ActivityRecord, right: ActivityRecord) {
	return (
		(left.timestamp ?? "").localeCompare(right.timestamp ?? "") ||
		left.id.localeCompare(right.id)
	)
}

function mergeNotificationRecords(
	current: Record<string, AppNotification[]>,
	incoming: Record<string, AppNotification[]> = {},
) {
	const notifications = { ...current }
	for (const [email, records] of Object.entries(incoming)) {
		const existing = notifications[email] ?? []
		const existingIds = new Set(existing.map((record) => record.id))
		const missing = records.filter((record) => !existingIds.has(record.id))
		if (missing.length) notifications[email] = [...existing, ...missing]
	}
	return notifications
}

async function saveRepositoryState(
	accessToken: string,
	state: AppState,
	repositoryId: string,
	reason = "repository.save",
) {
	const repository = findRepository(state, repositoryId)
	const repositoryFilesLoaded = repositoryId in state.repositoryFiles
	const pullRequestIds = new Set(
		(state.pullRequests[repositoryId] ?? []).map(
			(pullRequest) => pullRequest.id,
		),
	)
	try {
		await saveLoadedRepositoryThreadDocuments(accessToken, repository, state)
		const saved = await saveRepositoryStateDocument(accessToken, repository, {
			repositoryFiles: state.repositoryFiles[repositoryId] ?? [],
			readmeFiles: state.repositoryReadmeFiles[repositoryId] ?? [],
			repositoryZipFileId: state.repositoryZipFileIds[repositoryId],
			issues: state.issues[repositoryId] ?? [],
			pullRequests: state.pullRequests[repositoryId] ?? [],
			pullRequestZipFileIds: Object.fromEntries(
				Object.entries(state.pullRequestZipFileIds).filter(([id]) =>
					pullRequestIds.has(id),
				),
			),
			activity: state.activity.filter(
				(record) => record.repositoryId === repositoryId,
			),
			storageVersion: state.repositoryStorageVersions?.[repositoryId],
			reason,
		})
		return {
			...state,
			repositoryStorageVersions: {
				...(state.repositoryStorageVersions ?? {}),
				[repositoryId]: saved.version,
			},
			loadedRepositoryIds: [
				...new Set([...(state.loadedRepositoryIds ?? []), repositoryId]),
			],
			loadedRepositoryFileIds: repositoryFilesLoaded
				? [...new Set([...(state.loadedRepositoryFileIds ?? []), repositoryId])]
				: state.loadedRepositoryFileIds,
			loadedRepositoryReadmeIds: [
				...new Set([...(state.loadedRepositoryReadmeIds ?? []), repositoryId]),
			],
		}
	} catch (error) {
		if (error instanceof GoogleDriveConflictError) {
			throw new Error(
				"Repository storage conflict detected. Refresh the page and try the change again.",
			)
		}
		throw error
	}
}

async function saveRepositoryStateDocument(
	accessToken: string,
	repository: RepositoryManifest,
	state: Omit<
		StoredRepositoryState,
		"schema" | "repositoryId" | "repositoryFiles" | "pullRequests"
	> & {
		repositoryFiles: RepositoryFile[]
		readmeFiles: RepositoryFile[]
		pullRequests: AppPullRequest[]
		storageVersion?: string
		reason?: string
	},
) {
	const readmeFiles = state.repositoryFiles.length
		? repositoryReadmeFilesForStorage(state.repositoryFiles)
		: repositoryReadmeFilesForStorage(state.readmeFiles)
	const raw = JSON.stringify(
		{
			schema: APP_SCHEMA.repositoryState,
			repositoryId: repository.id,
			repositoryFiles: repositoryFileMetadata(state.repositoryFiles),
			readmeFiles,
			repositoryZipFileId: state.repositoryZipFileId,
			issues: state.issues.map(issueForRepositoryIndex),
			pullRequests: state.pullRequests.map(pullRequestForRepositoryIndex),
			pullRequestZipFileIds: state.pullRequestZipFileIds,
			activity: state.activity,
		} satisfies StoredRepositoryState,
		null,
		2,
	)
	return await timed(
		"drive.repository.state.save",
		() =>
			saveGoogleDriveFileByName({
				accessToken,
				parentId: repository.rootFolderId,
				name: repositoryStateFileName(repository),
				raw,
				expectedVersion: state.storageVersion,
			}),
		{
			reason: state.reason,
			repositoryId: repository.id,
			repositoryFiles: state.repositoryFiles.length,
			issues: state.issues.length,
			pullRequests: state.pullRequests.length,
			activityRecords: state.activity.length,
			pullRequestZipFileIds: Object.keys(state.pullRequestZipFileIds).length,
			bytes: new Blob([raw]).size,
			expectedVersion: Boolean(state.storageVersion),
		},
	)
}

function repositoryFileMetadata(
	files: RepositoryFile[],
): StoredRepositoryFile[] {
	return files.map(({ path, size, contentHash, modifiedAt }) => ({
		path,
		size,
		contentHash,
		modifiedAt,
	}))
}

function issueForRepositoryIndex(issue: IssueRecord): IssueRecord {
	return {
		...issue,
		comments: [],
	}
}

function pullRequestForRepositoryIndex(
	pullRequest: AppPullRequest,
): StoredAppPullRequest {
	return {
		...pullRequestForStorage(pullRequest),
		comments: [],
	}
}

function pullRequestForStorage(
	pullRequest: AppPullRequest,
): StoredAppPullRequest {
	return {
		...pullRequest,
		files: repositoryFileMetadata(pullRequest.files),
		baseFiles: pullRequest.baseFiles.map(repositoryFileForSidecar),
	}
}

async function appendRepositoryThreadRecord({
	accessToken,
	repository,
	record,
}: {
	accessToken: string
	repository: RepositoryManifest
	record: StoredRepositoryAppendRecord
}) {
	await timed(
		"drive.repository.append.save",
		() =>
			createGoogleDriveFile({
				accessToken,
				parentId: repository.rootFolderId,
				name: repositoryAppendFileName(repository, record.id),
				raw: JSON.stringify(record, null, 2),
			}),
		{ repositoryId: repository.id, kind: record.kind },
	)
}

async function saveNotificationAdditions(
	accessToken: string,
	previous: Record<string, AppNotification[]>,
	next: Record<string, AppNotification[]>,
) {
	const additions = notificationAdditions(previous, next)
	if (!additions.length) return

	await timed(
		"drive.notifications.save",
		async () => {
			let lastError: unknown
			for (let attempt = 0; attempt < 3; attempt += 1) {
				const currentState = await loadOrCreateAppState(accessToken, "", {
					includeRepositoryDetails: false,
				})
				const notifications = { ...currentState.notifications }
				let changed = false
				for (const [email, records] of additions) {
					const current = notifications[email] ?? []
					const currentIds = new Set(current.map((record) => record.id))
					const missing = records.filter((record) => !currentIds.has(record.id))
					if (!missing.length) continue
					notifications[email] = [...current, ...missing]
					changed = true
				}
				if (!changed) return
				try {
					await saveAppState(accessToken, { ...currentState, notifications })
					return
				} catch (cause) {
					lastError = cause
					if (!isStorageConflict(cause)) throw cause
				}
			}
			throw lastError instanceof Error
				? lastError
				: new Error("Notification save failed.")
		},
		{
			notifications: additions.reduce(
				(total, [, records]) => total + records.length,
				0,
			),
		},
	)
}

function notificationAdditions(
	previous: Record<string, AppNotification[]>,
	next: Record<string, AppNotification[]>,
) {
	return Object.entries(next)
		.map(([email, records]) => {
			const previousIds = new Set(
				(previous[email] ?? []).map((record) => record.id),
			)
			return [
				email,
				records.filter((record) => !previousIds.has(record.id)),
			] as const
		})
		.filter(([, records]) => records.length > 0)
}

function notificationAdditionRecord(
	previous: Record<string, AppNotification[]>,
	next: Record<string, AppNotification[]>,
) {
	return Object.fromEntries(notificationAdditions(previous, next))
}

function isStorageConflict(cause: unknown) {
	return (
		cause instanceof Error &&
		(cause.message.includes("Storage conflict detected") ||
			cause.message.includes("Repository storage conflict detected"))
	)
}

function stagedUploadFolderName(label: string) {
	const suffix = label
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80)
	return `${APP_STORAGE.stagedUploadFolderPrefix}-${crypto.randomUUID()}${
		suffix ? `-${suffix}` : ""
	}`
}

function stagedDownloadFolderName(label: string) {
	const suffix = label
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80)
	return `${APP_STORAGE.stagedDownloadFolderPrefix}-${crypto.randomUUID()}${
		suffix ? `-${suffix}` : ""
	}`
}

export type ZipDownloadLink = {
	name: string
	fetchUrl: string
	fileId: string
	folderId: string
	permissionId: string
}

async function beginStagedZipUpload({
	accessToken,
	state,
	label,
	zipName,
	zipBytes,
	origin,
}: {
	accessToken: string
	state: AppState
	label: string
	zipName: string
	zipBytes: number
	origin: string
}) {
	await assertDriveQuotaForZipUpload(accessToken, zipBytes)
	const uploadFolder = await createGoogleDriveFolder({
		accessToken,
		name: stagedUploadFolderName(label),
		parentId: state.rootFolder.id,
	})
	try {
		const uploadUrl = await createGoogleDriveUploadSession({
			accessToken,
			parentId: uploadFolder.id,
			name: zipName,
			contentType: "application/zip",
			contentLength: zipBytes,
			origin,
		})
		return {
			uploadFolderId: uploadFolder.id,
			uploadUrl,
		}
	} catch (cause) {
		await deleteGoogleDriveFile(accessToken, uploadFolder.id).catch(
			() => undefined,
		)
		throw cause
	}
}

export async function sweepStaleZipUploadFolders({
	accessToken,
	state,
	now = Date.now(),
}: {
	accessToken: string
	state: AppState
	now?: number
}) {
	const committedFolderIds = new Set(
		state.repositories.map((repository) => repository.rootFolderId),
	)
	const staleBefore =
		now - APP_UPLOAD.zipUploadTicketTtlMs - APP_UPLOAD.stagedUploadSweepGraceMs
	const folders = await listGoogleDriveChildFoldersByPrefix({
		accessToken,
		parentId: state.rootFolder.id,
		prefix: `${APP_STORAGE.stagedUploadFolderPrefix}-`,
	})
	const staleFolders = folders
		.filter((folder) => !committedFolderIds.has(folder.id))
		.filter((folder) => {
			const createdAt = Date.parse(folder.createdTime ?? "")
			return Number.isFinite(createdAt) && createdAt < staleBefore
		})
		.slice(0, APP_UPLOAD.stagedUploadSweepMaxDeletes)

	await Promise.all(
		staleFolders.map((folder) =>
			deleteGoogleDriveFile(accessToken, folder.id).catch(() => undefined),
		),
	)
}

export async function sweepStaleZipDownloadFolders({
	accessToken,
	state,
	now = Date.now(),
}: {
	accessToken: string
	state: AppState
	now?: number
}) {
	const staleBefore =
		now -
		(state.settings.downloadCleanupDelayMs ?? APP_DOWNLOAD.cleanupDelayMs) -
		APP_DOWNLOAD.cleanupGraceMs
	const folders = await listGoogleDriveChildFoldersByPrefix({
		accessToken,
		parentId: state.rootFolder.id,
		prefix: `${APP_STORAGE.stagedDownloadFolderPrefix}-`,
	})
	const staleFolders = folders
		.filter((folder) => {
			const createdAt = Date.parse(folder.createdTime ?? "")
			return Number.isFinite(createdAt) && createdAt < staleBefore
		})
		.slice(0, APP_DOWNLOAD.stagedDownloadSweepMaxDeletes)

	await Promise.all(
		staleFolders.map((folder) =>
			deleteGoogleDriveFile(accessToken, folder.id).catch(() => undefined),
		),
	)
}

export async function beginRepositoryArchiveUpload({
	accessToken,
	state,
	owner,
	name,
	zipBytes,
	origin,
}: {
	accessToken: string
	state: AppState
	owner: string
	name: string
	zipBytes: number
	origin: string
}) {
	assertRepositoryName(name)
	if (
		state.repositories.some(
			(repo) => repo.owner === owner && repo.name === name,
		)
	) {
		throw new Error(`Repository already exists: ${owner}/${name}`)
	}
	const upload = await beginStagedZipUpload({
		accessToken,
		state,
		label: `${owner}-${name}`,
		zipName: APP_STORAGE.repositoryZipFileName,
		zipBytes,
		origin,
	})
	return {
		repositoryRootFolderId: upload.uploadFolderId,
		uploadUrl: upload.uploadUrl,
	}
}

export async function beginPullRequestArchiveUpload({
	accessToken,
	state,
	repository,
	baseRepositoryZipFileId,
	zipBytes,
	origin,
}: {
	accessToken: string
	state: AppState
	repository: RepositoryManifest
	baseRepositoryZipFileId: string
	zipBytes: number
	origin: string
}) {
	if (!repository.policy.prsEnabled)
		throw new Error("Pull requests are disabled.")
	if (state.repositoryZipFileIds[repository.id] !== baseRepositoryZipFileId) {
		throw new Error("Repository changed before the upload started.")
	}
	return await beginStagedZipUpload({
		accessToken,
		state,
		label: `${repository.id}-pull`,
		zipName: APP_STORAGE.stagedUploadZipFileName,
		zipBytes,
		origin,
	})
}

export async function beginMergedRepositoryArchiveUpload({
	accessToken,
	state,
	repository,
	baseRepositoryZipFileId,
	zipBytes,
	origin,
}: {
	accessToken: string
	state: AppState
	repository: RepositoryManifest
	baseRepositoryZipFileId: string
	zipBytes: number
	origin: string
}) {
	return await beginRepositoryZipReplacementUpload({
		accessToken,
		state,
		repository,
		baseRepositoryZipFileId,
		label: "merge",
		zipBytes,
		origin,
	})
}

export async function beginGitHubMirrorSyncArchiveUpload({
	accessToken,
	state,
	repository,
	baseRepositoryZipFileId,
	zipBytes,
	origin,
}: {
	accessToken: string
	state: AppState
	repository: RepositoryManifest
	baseRepositoryZipFileId: string
	zipBytes: number
	origin: string
}) {
	if (!repository.githubMirror)
		throw new Error("Repository is not a GitHub mirror.")
	return await beginRepositoryZipReplacementUpload({
		accessToken,
		state,
		repository,
		baseRepositoryZipFileId,
		label: "github",
		zipBytes,
		origin,
	})
}

async function beginRepositoryZipReplacementUpload({
	accessToken,
	state,
	repository,
	baseRepositoryZipFileId,
	label,
	zipBytes,
	origin,
}: {
	accessToken: string
	state: AppState
	repository: RepositoryManifest
	baseRepositoryZipFileId: string
	label: string
	zipBytes: number
	origin: string
}) {
	if (state.repositoryZipFileIds[repository.id] !== baseRepositoryZipFileId) {
		throw new Error("Repository changed before the upload started.")
	}
	return await beginStagedZipUpload({
		accessToken,
		state,
		label: `${repository.id}-${label}`,
		zipName: APP_STORAGE.repositoryZipFileName,
		zipBytes,
		origin,
	})
}

export async function cancelZipArchiveUpload({
	accessToken,
	uploadFolderId,
}: {
	accessToken: string
	uploadFolderId: string
}) {
	await deleteGoogleDriveFile(accessToken, uploadFolderId).catch(
		() => undefined,
	)
}

async function assertStagedZipUpload({
	accessToken,
	fileId,
	folderId,
	name,
	bytes,
}: {
	accessToken: string
	fileId: string
	folderId: string
	name: string
	bytes: number
}) {
	const zipMetadata = await getGoogleDriveFileMetadata(accessToken, fileId)
	if (
		zipMetadata.name !== name ||
		zipMetadata.size !== String(bytes) ||
		!zipMetadata.parents?.includes(folderId)
	) {
		throw new Error("ZIP upload metadata did not match.")
	}
	return zipMetadata
}

function metadataFilesForRuntime(
	files: UploadedRepositoryFileMetadata[],
	settings: AppSettings,
	kind: "repository" | "pull-request",
) {
	return prepareRepositoryUploadMetadata(files, settings, kind).map(
		(file) =>
			({
				...file,
				content: file.content ?? "",
				encoding: file.encoding ?? "utf8",
			}) satisfies RepositoryFile,
	)
}

function assertPullRequestDiffMetadata(
	diff: FileDiff[],
	files: RepositoryFile[],
) {
	if (!diff.length) throw new Error("Pull request has no changes.")
	const filesByPath = new Map(files.map((file) => [file.path, file]))
	for (const fileDiff of diff) {
		assertRepositoryContentPath(fileDiff.path)
		if (fileDiff.status === "unchanged") {
			throw new Error("Pull request diff cannot include unchanged files.")
		}
		const file = filesByPath.get(fileDiff.path)
		if (fileDiff.status === "deleted") {
			if (file) throw new Error(`Deleted file has upload data: ${file.path}`)
			continue
		}
		if (!file) throw new Error(`Changed file is missing: ${fileDiff.path}`)
		if (fileDiff.afterHash && fileDiff.afterHash !== file.contentHash) {
			throw new Error(`Changed file hash does not match: ${file.path}`)
		}
	}
}

export async function completeRepositoryArchiveUpload({
	accessToken,
	state,
	actorEmail,
	owner,
	name,
	description,
	repositoryRootFolderId,
	repositoryZipFileId,
	repositoryZipBytes,
	files,
	githubMirror,
}: {
	accessToken: string
	state: AppState
	actorEmail: string
	owner: string
	name: string
	description?: string
	repositoryRootFolderId: string
	repositoryZipFileId: string
	repositoryZipBytes: number
	files: UploadedRepositoryFileMetadata[]
	githubMirror?: RepositoryManifest["githubMirror"]
}) {
	try {
		if (githubMirror && !state.settings.allowPublicGitMirrors) {
			throw new Error("Public GitHub mirrors are disabled.")
		}
		await assertStagedZipUpload({
			accessToken,
			fileId: repositoryZipFileId,
			folderId: repositoryRootFolderId,
			name: APP_STORAGE.repositoryZipFileName,
			bytes: repositoryZipBytes,
		})
		const repositoryFiles = metadataFilesForRuntime(
			files,
			state.settings,
			"repository",
		)
		return await createRepositoryWithPreparedFiles({
			accessToken,
			state,
			actorEmail,
			owner,
			name,
			description,
			repositoryFiles,
			repoFolder: {
				id: repositoryRootFolderId,
				name: `${owner}-${name}`,
			},
			zipFile: {
				id: repositoryZipFileId,
				name: APP_STORAGE.repositoryZipFileName,
			},
			githubMirror,
			returnRepositoryFiles: false,
		})
	} catch (cause) {
		await deleteGoogleDriveFile(accessToken, repositoryRootFolderId).catch(
			() => undefined,
		)
		throw cause
	}
}

export async function completePullRequestArchiveUpload({
	accessToken,
	state,
	actorEmail,
	repositoryId,
	title,
	body,
	uploadFolderId,
	uploadZipFileId,
	uploadZipBytes,
	baseRepositoryZipFileId,
	files,
	baseFiles,
	diff,
}: {
	accessToken: string
	state: AppState
	actorEmail: string
	repositoryId: string
	title: string
	body: string
	uploadFolderId: string
	uploadZipFileId: string
	uploadZipBytes: number
	baseRepositoryZipFileId: string
	files: UploadedRepositoryFileMetadata[]
	baseFiles: UploadedRepositoryFileMetadata[]
	diff: FileDiff[]
}) {
	const repository = findRepository(state, repositoryId)
	try {
		if (state.repositoryZipFileIds[repositoryId] !== baseRepositoryZipFileId) {
			throw new Error("Repository changed before the PR was committed.")
		}
		await assertStagedZipUpload({
			accessToken,
			fileId: uploadZipFileId,
			folderId: uploadFolderId,
			name: APP_STORAGE.stagedUploadZipFileName,
			bytes: uploadZipBytes,
		})
		if (!repository.policy.prsEnabled)
			throw new Error("Pull requests are disabled.")
		if (!title.trim() || !body.trim()) {
			throw new Error("Pull request title and body are required.")
		}
		const changedFiles = files.length
			? metadataFilesForRuntime(files, state.settings, "pull-request")
			: []
		assertPullRequestDiffMetadata(diff, changedFiles)
		const baseSidecars = baseFiles.length
			? pullRequestBaseFilesForSidecar(
					metadataFilesForRuntime(baseFiles, state.settings, "pull-request"),
				)
			: []
		const recordId = `${APP_STORAGE.pullRequestFolderPrefix}-${crypto.randomUUID()}`
		const prFolder = await createGoogleDriveFolder({
			accessToken,
			name: recordId,
			parentId: repository.rootFolderId,
		})
		try {
			const zipFile = await moveGoogleDriveFile({
				accessToken,
				fileId: uploadZipFileId,
				addParentId: prFolder.id,
				removeParentId: uploadFolderId,
				name: `${recordId}.zip`,
			})
			const now = new Date().toISOString()
			const pullRequest: AppPullRequest = {
				id: `${repositoryId}:pull:${recordId}`,
				number: 0,
				authorEmail: actorEmail,
				title: title.trim(),
				body: body.trim(),
				state: "open",
				createdAt: now,
				updatedAt: now,
				files: changedFiles,
				baseFiles: baseSidecars,
				diff,
				comments: [],
			}
			const notifications = addMentionNotifications({
				state,
				repositoryId,
				sourceId: pullRequest.id,
				actorEmail,
				text: `${pullRequest.title}\n${pullRequest.body}`,
				message: `${actorEmail} mentioned you in a PR`,
				now,
			})
			const activity: ActivityRecord[] = [
				{
					id: `${pullRequest.id}:created:${Date.now()}`,
					repositoryId,
					actorEmail,
					kind: "pr.created",
					timestamp: now,
					message: `${actorEmail} opened a PR: ${pullRequest.title}`,
				},
			]
			const appendRecord: StoredRepositoryAppendRecord = {
				schema: APP_SCHEMA.repositoryAppend,
				id: recordId,
				repositoryId,
				createdAt: now,
				kind: "pull.created",
				pullRequest: pullRequestForStorage(pullRequest),
				pullRequestZipFileId: zipFile.id,
				activity,
				notifications: notificationAdditionRecord(
					state.notifications,
					notifications,
				),
			}
			await appendRepositoryThreadRecord({
				accessToken,
				repository,
				record: appendRecord,
			})
			await saveNotificationAdditions(
				accessToken,
				state.notifications,
				notifications,
			).catch(() => undefined)
			await deleteGoogleDriveFile(accessToken, uploadFolderId).catch(
				() => undefined,
			)
			return materializeAppStateWithAppendRecord(
				state,
				repositoryId,
				appendRecord,
			)
		} catch (cause) {
			await deleteGoogleDriveFile(accessToken, prFolder.id).catch(
				() => undefined,
			)
			throw cause
		}
	} catch (cause) {
		await deleteGoogleDriveFile(accessToken, uploadFolderId).catch(
			() => undefined,
		)
		throw cause
	}
}

async function snapshotForRepositoryZip({
	accessToken,
	zipFileId,
	source,
	pullRequestNumber,
}: {
	accessToken: string
	zipFileId: string
	source: RepositorySnapshot["source"]
	pullRequestNumber?: number
}): Promise<RepositorySnapshot> {
	const bytes = await downloadGoogleDriveFile(accessToken, zipFileId)
	const digest = await crypto.subtle.digest("SHA-256", bytes)
	const sha256 = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("")
	return {
		revision: sha256,
		sha256,
		archiveBytes: bytes.byteLength,
		driveFileId: zipFileId,
		createdAt: new Date().toISOString(),
		source,
		pullRequestNumber,
	}
}

type IntegrationStateFields = Pick<
	AppState,
	"repositorySnapshots" | "integrationEvents" | "integrationNextCursor"
>

export function appendRepositorySnapshot<T extends IntegrationStateFields>(
	state: T,
	repositoryId: string,
	snapshot: RepositorySnapshot,
): Omit<T, keyof IntegrationStateFields> & IntegrationStateFields {
	const cursor = state.integrationNextCursor
	return {
		...state,
		repositorySnapshots: {
			...state.repositorySnapshots,
			[repositoryId]: [
				...(state.repositorySnapshots[repositoryId] ?? []),
				snapshot,
			],
		},
		integrationEvents: [
			...state.integrationEvents,
			{
				cursor,
				id: `${repositoryId}:${snapshot.revision}:${cursor}`,
				type: "repository.snapshot",
				repositoryId,
				revision: snapshot.revision,
				createdAt: snapshot.createdAt,
			},
		],
		integrationNextCursor: cursor + 1,
	}
}

export async function ensureIntegrationSnapshots(
	accessToken: string,
	state: AppState,
) {
	let nextState = state
	for (const repository of state.repositories) {
		if (
			repository.archived ||
			nextState.repositorySnapshots[repository.id]?.length
		) {
			continue
		}
		const zipFileId = nextState.repositoryZipFileIds[repository.id]
		if (!zipFileId) continue
		const snapshot = await snapshotForRepositoryZip({
			accessToken,
			zipFileId,
			source: "repository.created",
		})
		nextState = appendRepositorySnapshot(nextState, repository.id, snapshot)
	}
	if (nextState !== state) await saveAppState(accessToken, nextState)
	return nextState
}

async function createRepositoryWithPreparedFiles({
	accessToken,
	state,
	actorEmail,
	owner,
	name,
	description,
	repositoryFiles,
	repoFolder,
	zipFile,
	githubMirror,
	returnRepositoryFiles = true,
}: {
	accessToken: string
	state: AppState
	actorEmail: string
	owner: string
	name: string
	description?: string
	repositoryFiles: RepositoryFile[]
	repoFolder: GoogleDriveFile
	zipFile: GoogleDriveFile
	githubMirror?: RepositoryManifest["githubMirror"]
	returnRepositoryFiles?: boolean
}) {
	assertRepositoryName(name)
	if (
		state.repositories.some(
			(repo) => repo.owner === owner && repo.name === name,
		)
	) {
		throw new Error(`Repository already exists: ${owner}/${name}`)
	}
	if (
		repoFolder &&
		state.repositories.some((repo) => repo.rootFolderId === repoFolder.id)
	) {
		throw new Error(`Repository storage already exists: ${owner}/${name}`)
	}
	const folder = repoFolder
	try {
		const manifest = createRepositoryManifest({
			owner,
			name,
			description,
			rootFolderId: folder.id,
			files: repositoryFiles,
			vcs: githubMirror ? "git" : "folder",
			visibility: state.settings.defaultRepoVisibility,
			policy: state.settings.defaultRepoPolicy,
			githubMirror,
		})
		manifest.maintainers = [
			{
				userId: actorEmail,
				email: actorEmail,
				permissions: ["triage", "merge", "settings"],
			},
		]
		await uploadFileToGoogleDrive({
			accessToken,
			parentId: folder.id,
			name: APP_STORAGE.repositoryManifestFileName,
			blob: new Blob([JSON.stringify(manifest, null, 2)], {
				type: "application/json",
			}),
		})

		const snapshot = await snapshotForRepositoryZip({
			accessToken,
			zipFileId: zipFile.id,
			source: "repository.created",
		})
		const repositoryState: AppState = {
			...state,
			repositories: [...state.repositories, manifest],
			repositoryFiles: {
				...state.repositoryFiles,
				[manifest.id]: repositoryFiles,
			},
			repositoryReadmeFiles: {
				...state.repositoryReadmeFiles,
				[manifest.id]: storedRepositoryFilesWithContent(
					repositoryReadmeFilesForStorage(repositoryFiles),
				),
			},
			repositoryZipFileIds: {
				...state.repositoryZipFileIds,
				[manifest.id]: zipFile.id,
			},
			activity: [
				...state.activity,
				{
					id: `${manifest.id}:repo.created:${Date.now()}`,
					repositoryId: manifest.id,
					actorEmail,
					kind: "repo.created",
					timestamp: new Date().toISOString(),
					message: `${actorEmail} created ${manifest.owner}/${manifest.name}`,
				},
			],
		}
		const nextState = appendRepositorySnapshot(
			repositoryState,
			manifest.id,
			snapshot,
		)
		const savedState = await saveRepositoryState(
			accessToken,
			nextState,
			manifest.id,
			"repository.create",
		)
		await saveAppState(accessToken, savedState)
		if (!returnRepositoryFiles) {
			const { [manifest.id]: _files, ...repositoryFilesById } =
				savedState.repositoryFiles
			return {
				...savedState,
				repositoryFiles: repositoryFilesById,
				loadedRepositoryReadmeIds: [
					...new Set([
						...(savedState.loadedRepositoryReadmeIds ?? []),
						manifest.id,
					]),
				],
				loadedRepositoryFileIds: (
					savedState.loadedRepositoryFileIds ?? []
				).filter((id) => id !== manifest.id),
			}
		}
		return savedState
	} catch (cause) {
		await deleteGoogleDriveFile(accessToken, folder.id).catch(() => undefined)
		throw cause
	}
}

export async function updateRepositoryAccessInDriveState({
	accessToken,
	state,
	actor,
	repositoryId,
	name,
	description,
	visibility,
	policy,
	accessEmails,
}: {
	accessToken: string
	state: AppState
	actor: Actor
	repositoryId: string
	name?: string
	description?: string
	visibility: RepositoryManifest["visibility"]
	policy: RepositoryPolicy
	accessEmails: string[]
}) {
	const repository = findRepository(state, repositoryId)
	if (!canOwnRepository(actor, repository)) {
		throw new Error("Repository settings permission is required.")
	}
	const now = new Date().toISOString()
	const nextName = (name ?? repository.name).trim()
	assertRepositoryName(nextName)
	const nextId = `${repository.owner}/${nextName}`
	if (
		nextId !== repositoryId &&
		state.repositories.some((candidate) => candidate.id === nextId)
	) {
		throw new Error(`Repository already exists: ${nextId}`)
	}
	const nextDescription = description?.trim() || undefined
	const normalizedEmails = uniqueNormalizedEmails(accessEmails)
	for (const email of normalizedEmails) {
		const user = state.users[email]
		if (!user) throw new Error(`User is not registered: ${email}`)
	}
	const access: RepositoryAccessGrant[] = normalizedEmails.map((email) => ({
		email,
		addedAt:
			repository.access?.find((grant) => grant.email === email)?.addedAt ?? now,
		addedBy:
			repository.access?.find((grant) => grant.email === email)?.addedBy ??
			actor.email,
	}))
	const repositoryFiles = moveRepositoryRecord(
		state.repositoryFiles,
		repositoryId,
		nextId,
	)
	const repositoryReadmeFiles = moveRepositoryRecord(
		state.repositoryReadmeFiles,
		repositoryId,
		nextId,
	)
	const repositoryZipFileIds = moveRepositoryRecord(
		state.repositoryZipFileIds,
		repositoryId,
		nextId,
	)
	const issues = moveRepositoryRecord(state.issues, repositoryId, nextId)
	const pullRequests = moveRepositoryRecord(
		state.pullRequests,
		repositoryId,
		nextId,
	)
	const pullRequestZipFileIds = moveRepositoryRecord(
		state.pullRequestZipFileIds,
		repositoryId,
		nextId,
	)
	const repositoryStorageVersions = moveRepositoryRecord(
		state.repositoryStorageVersions ?? {},
		repositoryId,
		nextId,
	)
	const nextState: AppState = {
		...state,
		repositories: state.repositories.map((candidate) =>
			candidate.id === repositoryId
				? {
						...candidate,
						id: nextId,
						name: nextName,
						description: nextDescription,
						visibility,
						policy,
						access,
						updatedAt: now,
					}
				: candidate,
		),
		repositoryFiles,
		repositoryReadmeFiles,
		repositoryZipFileIds,
		issues,
		pullRequests,
		pullRequestZipFileIds,
		repositoryStorageVersions,
		loadedRepositoryIds: (state.loadedRepositoryIds ?? []).map((id) =>
			id === repositoryId ? nextId : id,
		),
		loadedRepositoryFileIds: (state.loadedRepositoryFileIds ?? []).map((id) =>
			id === repositoryId ? nextId : id,
		),
		loadedRepositoryReadmeIds: (state.loadedRepositoryReadmeIds ?? []).map(
			(id) => (id === repositoryId ? nextId : id),
		),
		loadedPullRequestFileIds: (state.loadedPullRequestFileIds ?? []).map(
			(id) =>
				id.startsWith(`${repositoryId}:pull:`)
					? id.replace(`${repositoryId}:pull:`, `${nextId}:pull:`)
					: id,
		),
		loadedThreadIds: state.loadedThreadIds,
		watches: Object.fromEntries(
			Object.entries(state.watches).map(([email, repositoryIds]) => [
				email,
				repositoryIds.map((id) => (id === repositoryId ? nextId : id)),
			]),
		),
		notifications: Object.fromEntries(
			Object.entries(state.notifications).map(([email, notifications]) => [
				email,
				notifications.map((notification) =>
					notification.repositoryId === repositoryId
						? { ...notification, repositoryId: nextId }
						: notification,
				),
			]),
		),
		activity: [
			...state.activity.map((record) =>
				record.repositoryId === repositoryId
					? { ...record, repositoryId: nextId }
					: record,
			),
			{
				id: `${nextId}:settings.updated:${Date.now()}`,
				repositoryId: nextId,
				actorEmail: actor.email,
				kind: "settings.updated",
				timestamp: now,
				message: `${actor.email} updated settings for ${repository.owner}/${nextName}`,
			},
		],
	}
	const savedState = await saveRepositoryState(
		accessToken,
		nextState,
		nextId,
		"repository.settings",
	)
	await saveAppState(accessToken, savedState)
	return savedState
}

export async function setRepositoryWatch({
	accessToken,
	state,
	actorEmail,
	repositoryId,
	watched,
}: {
	accessToken: string
	state: AppState
	actorEmail: string
	repositoryId: string
	watched: boolean
}) {
	const current = new Set(state.watches[actorEmail] ?? [])
	if (watched) current.add(repositoryId)
	else current.delete(repositoryId)

	const nextState: AppState = {
		...state,
		watches: {
			...state.watches,
			[actorEmail]: [...current].sort(),
		},
		activity: watched
			? [
					...state.activity,
					{
						id: `${repositoryId}:repo.watched:${actorEmail}:${Date.now()}`,
						repositoryId,
						actorEmail,
						kind: "repo.watched",
						timestamp: new Date().toISOString(),
						message: `${actorEmail} watched ${repositoryId}`,
					},
				]
			: state.activity,
	}
	await saveAppState(accessToken, nextState)
	return nextState
}

export async function markNotificationsReadInDriveState({
	accessToken,
	state,
	actorEmail,
}: {
	accessToken: string
	state: AppState
	actorEmail: string
}) {
	const email = actorEmail.trim().toLowerCase()
	const current = state.notifications[email] ?? []
	if (!current.some((notification) => !notification.read)) return state
	const nextState: AppState = {
		...state,
		notifications: {
			...state.notifications,
			[email]: current.map((notification) => ({
				...notification,
				read: true,
			})),
		},
	}
	await saveAppState(accessToken, nextState)
	return nextState
}

export async function updateAppSettings({
	accessToken,
	state,
	actorEmail,
	settings,
}: {
	accessToken: string
	state: AppState
	actorEmail: string
	settings: AppSettings
}) {
	const nextState: AppState = {
		...state,
		settings: {
			...settings,
			ownerName: state.settings.ownerName,
			backupTargets: state.settings.backupTargets,
			updatedAt: new Date().toISOString(),
			updatedBy: actorEmail,
		},
		activity: [
			...state.activity,
			{
				id: `settings.updated:${Date.now()}`,
				repositoryId: "settings",
				actorEmail,
				kind: "settings.updated",
				timestamp: new Date().toISOString(),
				message: `${actorEmail} updated ${APP_NAME} settings`,
			},
		],
	}
	await saveAppState(accessToken, nextState)
	return nextState
}

export async function updateUserNameInDriveState({
	accessToken,
	state,
	actorEmail,
	ownerName,
}: {
	accessToken: string
	state: AppState
	actorEmail: string
	ownerName: string
}) {
	const normalizedActorEmail = actorEmail.trim().toLowerCase()
	const nextOwnerName = normalizeOwnerName(ownerName)
	const conflictingUser = Object.values(state.users).find(
		(user) =>
			user.email !== normalizedActorEmail &&
			user.ownerName.toLowerCase() === nextOwnerName.toLowerCase(),
	)
	if (conflictingUser) throw new Error("Name is already used by another user.")

	const now = new Date().toISOString()
	const existingUser = state.users[normalizedActorEmail]
	const user = {
		email: normalizedActorEmail,
		ownerName: nextOwnerName,
		createdAt: existingUser?.createdAt ?? now,
		updatedAt: now,
	}
	const idMap = new Map<string, string>()
	const repositories = state.repositories.map((repo) => {
		if (
			!repo.maintainers.some(
				(maintainer) =>
					maintainer.email.toLowerCase() === normalizedActorEmail &&
					maintainer.permissions.includes("settings"),
			)
		) {
			return repo
		}
		const id = `${nextOwnerName}/${repo.name}`
		idMap.set(repo.id, id)
		return { ...repo, id, owner: nextOwnerName, updatedAt: now }
	})
	const remapId = (id: string) => idMap.get(id) ?? id
	const nextState: AppState = {
		...state,
		users: {
			...state.users,
			[normalizedActorEmail]: user,
		},
		repositories,
		repositoryFiles: remapRecordKeys(state.repositoryFiles, remapId),
		repositoryReadmeFiles: remapRecordKeys(
			state.repositoryReadmeFiles,
			remapId,
		),
		repositoryZipFileIds: remapRecordKeys(state.repositoryZipFileIds, remapId),
		repositorySnapshots: remapRecordKeys(state.repositorySnapshots, remapId),
		integrationEvents: state.integrationEvents.map((event) => ({
			...event,
			repositoryId: remapId(event.repositoryId),
		})),
		issues: remapRecordKeys(state.issues, remapId),
		pullRequests: remapRecordKeys(state.pullRequests, remapId),
		pullRequestZipFileIds: remapRecordKeys(
			state.pullRequestZipFileIds,
			remapId,
		),
		repositoryStorageVersions: remapRecordKeys(
			state.repositoryStorageVersions ?? {},
			remapId,
		),
		loadedRepositoryIds: (state.loadedRepositoryIds ?? []).map(remapId),
		loadedRepositoryFileIds: (state.loadedRepositoryFileIds ?? []).map(remapId),
		loadedRepositoryReadmeIds: (state.loadedRepositoryReadmeIds ?? []).map(
			remapId,
		),
		loadedPullRequestFileIds: (state.loadedPullRequestFileIds ?? []).map(
			remapId,
		),
		watches: Object.fromEntries(
			Object.entries(state.watches).map(([email, repositoryIds]) => [
				email,
				[...new Set(repositoryIds.map(remapId))].sort(),
			]),
		),
		activity: [
			...state.activity.map((record) => ({
				...record,
				repositoryId: remapId(record.repositoryId),
			})),
			{
				id: `user.name.updated:${Date.now()}`,
				repositoryId: "settings",
				actorEmail,
				kind: "settings.updated",
				timestamp: now,
				message: `${actorEmail} updated their Name`,
			},
		],
	}
	let savedState = nextState
	for (const repositoryId of idMap.values()) {
		savedState = await saveRepositoryState(
			accessToken,
			savedState,
			repositoryId,
			"user.name.update",
		)
	}
	await saveAppState(accessToken, savedState)
	return savedState
}

export async function deleteRepositoryFromDrive({
	accessToken,
	state,
	actorEmail,
	repositoryId,
}: {
	accessToken: string
	state: AppState
	actorEmail: string
	repositoryId: string
}) {
	const repository = findRepository(state, repositoryId)
	await deleteGoogleDriveFile(accessToken, repository.rootFolderId)

	const nextState: AppState = {
		...state,
		repositories: state.repositories.filter((repo) => repo.id !== repositoryId),
		repositoryFiles: omitRecordKey(state.repositoryFiles, repositoryId),
		repositoryReadmeFiles: omitRecordKey(
			state.repositoryReadmeFiles,
			repositoryId,
		),
		repositoryZipFileIds: omitRecordKey(
			state.repositoryZipFileIds,
			repositoryId,
		),
		repositorySnapshots: omitRecordKey(state.repositorySnapshots, repositoryId),
		integrationEvents: state.integrationEvents.filter(
			(event) => event.repositoryId !== repositoryId,
		),
		issues: omitRecordKey(state.issues, repositoryId),
		pullRequests: omitRecordKey(state.pullRequests, repositoryId),
		pullRequestZipFileIds: Object.fromEntries(
			Object.entries(state.pullRequestZipFileIds).filter(
				([key]) => !key.startsWith(`${repositoryId}:pull:`),
			),
		),
		loadedRepositoryIds: (state.loadedRepositoryIds ?? []).filter(
			(id) => id !== repositoryId,
		),
		loadedRepositoryFileIds: (state.loadedRepositoryFileIds ?? []).filter(
			(id) => id !== repositoryId,
		),
		loadedRepositoryReadmeIds: (state.loadedRepositoryReadmeIds ?? []).filter(
			(id) => id !== repositoryId,
		),
		loadedPullRequestFileIds: (state.loadedPullRequestFileIds ?? []).filter(
			(id) => !id.startsWith(`${repositoryId}:pull:`),
		),
		loadedThreadIds: (state.loadedThreadIds ?? []).filter(
			(id) => !id.startsWith(`${repositoryId}:`),
		),
		watches: Object.fromEntries(
			Object.entries(state.watches).map(([email, repositoryIds]) => [
				email,
				repositoryIds.filter((id) => id !== repositoryId),
			]),
		),
		notifications: Object.fromEntries(
			Object.entries(state.notifications).map(([email, notifications]) => [
				email,
				notifications.filter(
					(notification) => notification.repositoryId !== repositoryId,
				),
			]),
		),
		activity: [
			...state.activity.filter(
				(record) => record.repositoryId !== repositoryId,
			),
			{
				id: `${repositoryId}:repo.deleted:${Date.now()}`,
				repositoryId,
				actorEmail,
				kind: "repo.deleted",
				timestamp: new Date().toISOString(),
				message: `${actorEmail} deleted ${repository.owner}/${repository.name}`,
			},
		],
	}
	await saveAppState(accessToken, nextState)
	return nextState
}

export async function createIssueInDriveState({
	accessToken,
	state,
	actorEmail,
	repositoryId,
	title,
	body,
	labels,
}: {
	accessToken: string
	state: AppState
	actorEmail: string
	repositoryId: string
	title: string
	body: string
	labels: string[]
}) {
	const repository = findRepository(state, repositoryId)
	if (!repository.policy.issuesEnabled) throw new Error("Issues are disabled.")
	assertIssueLabels(labels, repository)
	const now = new Date().toISOString()
	const recordId = `issue-${crypto.randomUUID()}`
	const issue: IssueRecord = {
		id: `${repositoryId}:issue:${recordId}`,
		number: 0,
		authorEmail: actorEmail,
		title: title.trim(),
		body: body.trim(),
		state: "open",
		labels,
		comments: [],
		createdAt: now,
		updatedAt: now,
	}
	if (!issue.title || !issue.body) {
		throw new Error("Issue title and body are required.")
	}

	const notifications = addMentionNotifications({
		state,
		repositoryId,
		sourceId: issue.id,
		actorEmail,
		text: `${issue.title}\n${issue.body}`,
		message: `${actorEmail} mentioned you in an issue`,
		now,
	})
	const appendNotifications = notificationAdditionRecord(
		state.notifications,
		notifications,
	)
	const activity: ActivityRecord[] = [
		{
			id: `${issue.id}:created:${Date.now()}`,
			repositoryId,
			actorEmail,
			kind: "issue.created",
			timestamp: now,
			message: `${actorEmail} opened an issue: ${issue.title}`,
		},
	]
	const appendRecord: StoredRepositoryAppendRecord = {
		schema: APP_SCHEMA.repositoryAppend,
		id: recordId,
		repositoryId,
		createdAt: now,
		kind: "issue.created",
		issue,
		activity,
		notifications: appendNotifications,
	}
	await appendRepositoryThreadRecord({
		accessToken,
		repository,
		record: appendRecord,
	})
	await saveNotificationAdditions(
		accessToken,
		state.notifications,
		notifications,
	).catch(() => undefined)
	return materializeAppStateWithAppendRecord(state, repositoryId, appendRecord)
}

export async function commentOnIssueInDriveState({
	accessToken,
	state,
	actorEmail,
	repositoryId,
	issueNumber,
	body,
}: {
	accessToken: string
	state: AppState
	actorEmail: string
	repositoryId: string
	issueNumber: number
	body: string
}) {
	const repository = findRepository(state, repositoryId)
	const now = new Date().toISOString()
	const issues = state.issues[repositoryId] ?? []
	const issue = findIssue(issues, issueNumber)
	const recordId = `comment-${crypto.randomUUID()}`
	const comment = {
		id: `${issue.id}:comment:${recordId}`,
		authorEmail: actorEmail,
		body: body.trim(),
		createdAt: now,
	}
	if (!comment.body) throw new Error("Comment body is required.")
	const notifications = addMentionNotifications({
		state,
		repositoryId,
		sourceId: comment.id,
		actorEmail,
		text: comment.body,
		message: `${actorEmail} mentioned you in issue #${issueNumber}`,
		now,
	})
	const appendNotifications = notificationAdditionRecord(
		state.notifications,
		notifications,
	)
	const activity: ActivityRecord[] = [
		{
			id: `${comment.id}:activity`,
			repositoryId,
			actorEmail,
			kind: "issue.commented",
			timestamp: now,
			message: `${actorEmail} commented on issue #${issueNumber}`,
		},
	]
	const nextState: AppState = {
		...state,
		issues: {
			...state.issues,
			[repositoryId]: issues.map((candidate) =>
				candidate.number === issueNumber
					? {
							...candidate,
							comments: [...candidate.comments, comment],
							updatedAt: now,
						}
					: candidate,
			),
		},
		activity: [...state.activity, ...activity],
		notifications,
	}
	await appendRepositoryThreadRecord({
		accessToken,
		repository,
		record: {
			schema: APP_SCHEMA.repositoryAppend,
			id: recordId,
			repositoryId,
			createdAt: now,
			kind: "issue.commented",
			targetId: issue.id,
			comment,
			activity,
			notifications: appendNotifications,
		},
	})
	await saveNotificationAdditions(
		accessToken,
		state.notifications,
		notifications,
	).catch(() => undefined)
	return nextState
}

export async function editIssueTitleInDriveState({
	accessToken,
	state,
	actor,
	repositoryId,
	issueNumber,
	title,
}: {
	accessToken: string
	state: AppState
	actor: Actor
	repositoryId: string
	issueNumber: number
	title: string
}) {
	const repository = findRepository(state, repositoryId)
	const issues = state.issues[repositoryId] ?? []
	const issue = findIssue(issues, issueNumber)
	if (!canEditThreadTitle(actor, repository, issue.authorEmail)) {
		throw new Error("Title edit permission is required.")
	}
	const nextTitle = title.trim()
	if (!nextTitle) throw new Error("Issue title is required.")
	const now = new Date().toISOString()
	const notifications = addMentionNotifications({
		state,
		repositoryId,
		sourceId: `${issue.id}:title.edited`,
		actorEmail: actor.email,
		text: nextTitle,
		message: `${actor.email} mentioned you in an edited issue title #${issueNumber}`,
		now,
	})
	const activity: ActivityRecord[] = [
		{
			id: `${issue.id}:title.edited:${Date.now()}`,
			repositoryId,
			actorEmail: actor.email,
			kind: "issue.commented",
			timestamp: now,
			message: `${actor.email} edited issue #${issueNumber} title`,
		},
	]
	const nextState: AppState = {
		...state,
		issues: {
			...state.issues,
			[repositoryId]: issues.map((candidate) =>
				candidate.number === issueNumber
					? { ...candidate, title: nextTitle, updatedAt: now }
					: candidate,
			),
		},
		activity: [...state.activity, ...activity],
		notifications,
	}
	await appendRepositoryThreadRecord({
		accessToken,
		repository,
		record: {
			schema: APP_SCHEMA.repositoryAppend,
			id: `issue-title-${crypto.randomUUID()}`,
			repositoryId,
			createdAt: now,
			kind: "issue.title.edited",
			targetId: issue.id,
			title: nextTitle,
			activity,
			notifications: notificationAdditionRecord(
				state.notifications,
				notifications,
			),
		},
	})
	await saveNotificationAdditions(
		accessToken,
		state.notifications,
		notifications,
	).catch(() => undefined)
	return nextState
}

export async function editIssueMessageInDriveState({
	accessToken,
	state,
	actor,
	repositoryId,
	issueNumber,
	messageId,
	body,
}: {
	accessToken: string
	state: AppState
	actor: Actor
	repositoryId: string
	issueNumber: number
	messageId: string
	body: string
}) {
	const repository = findRepository(state, repositoryId)
	const issues = state.issues[repositoryId] ?? []
	const issue = findIssue(issues, issueNumber)
	const nextBody = body.trim()
	if (!nextBody) throw new Error("Message body is required.")
	const now = new Date().toISOString()
	const canEdit = (authorEmail: string) =>
		authorEmail.toLowerCase() === actor.email.toLowerCase()
	let edited = false
	const nextIssue =
		messageId === issue.id
			? canEdit(issue.authorEmail)
				? { ...issue, body: nextBody, updatedAt: now, editedAt: now }
				: issue
			: {
					...issue,
					updatedAt: now,
					comments: issue.comments.map((comment) => {
						if (comment.id !== messageId) return comment
						if (!canEdit(comment.authorEmail)) return comment
						edited = true
						return {
							...comment,
							body: nextBody,
							updatedAt: now,
							editedAt: now,
						}
					}),
				}
	if (messageId === issue.id && canEdit(issue.authorEmail)) edited = true
	if (!edited) throw new Error("Message edit permission is required.")
	const notifications = addMentionNotifications({
		state,
		repositoryId,
		sourceId: `${messageId}:edited`,
		actorEmail: actor.email,
		text: nextBody,
		message: `${actor.email} mentioned you in an edited issue message #${issueNumber}`,
		now,
	})
	const activity: ActivityRecord[] = [
		{
			id: `${messageId}:edited:${Date.now()}`,
			repositoryId,
			actorEmail: actor.email,
			kind: "issue.commented",
			timestamp: now,
			message: `${actor.email} edited a message on issue #${issueNumber}`,
		},
	]
	const nextState: AppState = {
		...state,
		issues: {
			...state.issues,
			[repositoryId]: issues.map((candidate) =>
				candidate.number === issueNumber ? nextIssue : candidate,
			),
		},
		activity: [...state.activity, ...activity],
		notifications,
	}
	await appendRepositoryThreadRecord({
		accessToken,
		repository,
		record: {
			schema: APP_SCHEMA.repositoryAppend,
			id: `issue-message-${crypto.randomUUID()}`,
			repositoryId,
			createdAt: now,
			kind: "issue.message.edited",
			targetId: issue.id,
			messageId,
			body: nextBody,
			activity,
			notifications: notificationAdditionRecord(
				state.notifications,
				notifications,
			),
		},
	})
	await saveNotificationAdditions(
		accessToken,
		state.notifications,
		notifications,
	).catch(() => undefined)
	return nextState
}

export async function transitionIssueInDriveState({
	accessToken,
	state,
	actor,
	repositoryId,
	issueNumber,
	nextIssueState,
}: {
	accessToken: string
	state: AppState
	actor: Actor
	repositoryId: string
	issueNumber: number
	nextIssueState: IssueState
}) {
	const repository = findRepository(state, repositoryId)
	const issues = state.issues[repositoryId] ?? []
	const issue = findIssue(issues, issueNumber)
	const transitioned = transitionIssueState(
		actor,
		repository,
		issue,
		nextIssueState,
	)
	const nextState: AppState = {
		...state,
		issues: {
			...state.issues,
			[repositoryId]: issues.map((candidate) =>
				candidate.number === issueNumber ? transitioned : candidate,
			),
		},
		activity: [
			...state.activity,
			{
				id: `${issue.id}:state:${nextIssueState}:${Date.now()}`,
				repositoryId,
				actorEmail: actor.email,
				kind: nextIssueState === "closed" ? "issue.closed" : "issue.reopened",
				timestamp: transitioned.updatedAt,
				message: `${actor.email} ${nextIssueState} issue #${issueNumber}`,
			},
		],
	}
	await appendRepositoryThreadRecord({
		accessToken,
		repository,
		record: {
			schema: APP_SCHEMA.repositoryAppend,
			id: `issue-state-${crypto.randomUUID()}`,
			repositoryId,
			createdAt: transitioned.updatedAt,
			kind: "issue.state.changed",
			targetId: issue.id,
			issueState: nextIssueState,
			activity: nextState.activity.slice(state.activity.length),
			notifications: {},
		},
	})
	return nextState
}

export async function commentOnPullRequestInDriveState({
	accessToken,
	state,
	actorEmail,
	repositoryId,
	pullRequestNumber,
	body,
}: {
	accessToken: string
	state: AppState
	actorEmail: string
	repositoryId: string
	pullRequestNumber: number
	body: string
}) {
	const repository = findRepository(state, repositoryId)
	const now = new Date().toISOString()
	const pullRequests = state.pullRequests[repositoryId] ?? []
	const pullRequest = findPullRequest(pullRequests, pullRequestNumber)
	const recordId = `comment-${crypto.randomUUID()}`
	const comment = {
		id: `${pullRequest.id}:comment:${recordId}`,
		authorEmail: actorEmail,
		body: body.trim(),
		createdAt: now,
	}
	if (!comment.body) throw new Error("Comment body is required.")
	const notifications = addMentionNotifications({
		state,
		repositoryId,
		sourceId: comment.id,
		actorEmail,
		text: comment.body,
		message: `${actorEmail} mentioned you in PR #${pullRequestNumber}`,
		now,
	})
	const appendNotifications = notificationAdditionRecord(
		state.notifications,
		notifications,
	)
	const activity: ActivityRecord[] = [
		{
			id: `${comment.id}:activity`,
			repositoryId,
			actorEmail,
			kind: "pr.commented",
			timestamp: now,
			message: `${actorEmail} commented on PR #${pullRequestNumber}`,
		},
	]
	const nextState: AppState = {
		...state,
		pullRequests: {
			...state.pullRequests,
			[repositoryId]: pullRequests.map((candidate) =>
				candidate.number === pullRequestNumber
					? {
							...candidate,
							comments: [...candidate.comments, comment],
							updatedAt: now,
						}
					: candidate,
			),
		},
		activity: [...state.activity, ...activity],
		notifications,
	}
	await appendRepositoryThreadRecord({
		accessToken,
		repository,
		record: {
			schema: APP_SCHEMA.repositoryAppend,
			id: recordId,
			repositoryId,
			createdAt: now,
			kind: "pull.commented",
			targetId: pullRequest.id,
			comment,
			activity,
			notifications: appendNotifications,
		},
	})
	await saveNotificationAdditions(
		accessToken,
		state.notifications,
		notifications,
	).catch(() => undefined)
	return nextState
}

export async function editPullRequestTitleInDriveState({
	accessToken,
	state,
	actor,
	repositoryId,
	pullRequestNumber,
	title,
}: {
	accessToken: string
	state: AppState
	actor: Actor
	repositoryId: string
	pullRequestNumber: number
	title: string
}) {
	const repository = findRepository(state, repositoryId)
	const pullRequests = state.pullRequests[repositoryId] ?? []
	const pullRequest = findPullRequest(pullRequests, pullRequestNumber)
	if (!canEditThreadTitle(actor, repository, pullRequest.authorEmail)) {
		throw new Error("Title edit permission is required.")
	}
	const nextTitle = title.trim()
	if (!nextTitle) throw new Error("Pull request title is required.")
	const now = new Date().toISOString()
	const notifications = addMentionNotifications({
		state,
		repositoryId,
		sourceId: `${pullRequest.id}:title.edited`,
		actorEmail: actor.email,
		text: nextTitle,
		message: `${actor.email} mentioned you in an edited PR title #${pullRequestNumber}`,
		now,
	})
	const activity: ActivityRecord[] = [
		{
			id: `${pullRequest.id}:title.edited:${Date.now()}`,
			repositoryId,
			actorEmail: actor.email,
			kind: "pr.commented",
			timestamp: now,
			message: `${actor.email} edited PR #${pullRequestNumber} title`,
		},
	]
	const nextState: AppState = {
		...state,
		pullRequests: {
			...state.pullRequests,
			[repositoryId]: pullRequests.map((candidate) =>
				candidate.number === pullRequestNumber
					? { ...candidate, title: nextTitle, updatedAt: now }
					: candidate,
			),
		},
		activity: [...state.activity, ...activity],
		notifications,
	}
	await appendRepositoryThreadRecord({
		accessToken,
		repository,
		record: {
			schema: APP_SCHEMA.repositoryAppend,
			id: `pull-title-${crypto.randomUUID()}`,
			repositoryId,
			createdAt: now,
			kind: "pull.title.edited",
			targetId: pullRequest.id,
			title: nextTitle,
			activity,
			notifications: notificationAdditionRecord(
				state.notifications,
				notifications,
			),
		},
	})
	await saveNotificationAdditions(
		accessToken,
		state.notifications,
		notifications,
	).catch(() => undefined)
	return nextState
}

export async function editPullRequestMessageInDriveState({
	accessToken,
	state,
	actor,
	repositoryId,
	pullRequestNumber,
	messageId,
	body,
}: {
	accessToken: string
	state: AppState
	actor: Actor
	repositoryId: string
	pullRequestNumber: number
	messageId: string
	body: string
}) {
	const repository = findRepository(state, repositoryId)
	const pullRequests = state.pullRequests[repositoryId] ?? []
	const pullRequest = findPullRequest(pullRequests, pullRequestNumber)
	const nextBody = body.trim()
	if (!nextBody) throw new Error("Message body is required.")
	const now = new Date().toISOString()
	const canEdit = (authorEmail: string) =>
		authorEmail.toLowerCase() === actor.email.toLowerCase()
	let edited = false
	const nextPullRequest =
		messageId === pullRequest.id
			? canEdit(pullRequest.authorEmail)
				? { ...pullRequest, body: nextBody, updatedAt: now, editedAt: now }
				: pullRequest
			: {
					...pullRequest,
					updatedAt: now,
					comments: pullRequest.comments.map((comment) => {
						if (comment.id !== messageId) return comment
						if (!canEdit(comment.authorEmail)) return comment
						edited = true
						return {
							...comment,
							body: nextBody,
							updatedAt: now,
							editedAt: now,
						}
					}),
				}
	if (messageId === pullRequest.id && canEdit(pullRequest.authorEmail)) {
		edited = true
	}
	if (!edited) throw new Error("Message edit permission is required.")
	const notifications = addMentionNotifications({
		state,
		repositoryId,
		sourceId: `${messageId}:edited`,
		actorEmail: actor.email,
		text: nextBody,
		message: `${actor.email} mentioned you in an edited PR message #${pullRequestNumber}`,
		now,
	})
	const activity: ActivityRecord[] = [
		{
			id: `${messageId}:edited:${Date.now()}`,
			repositoryId,
			actorEmail: actor.email,
			kind: "pr.commented",
			timestamp: now,
			message: `${actor.email} edited a message on PR #${pullRequestNumber}`,
		},
	]
	const nextState: AppState = {
		...state,
		pullRequests: {
			...state.pullRequests,
			[repositoryId]: pullRequests.map((candidate) =>
				candidate.number === pullRequestNumber ? nextPullRequest : candidate,
			),
		},
		activity: [...state.activity, ...activity],
		notifications,
	}
	await appendRepositoryThreadRecord({
		accessToken,
		repository,
		record: {
			schema: APP_SCHEMA.repositoryAppend,
			id: `pull-message-${crypto.randomUUID()}`,
			repositoryId,
			createdAt: now,
			kind: "pull.message.edited",
			targetId: pullRequest.id,
			messageId,
			body: nextBody,
			activity,
			notifications: notificationAdditionRecord(
				state.notifications,
				notifications,
			),
		},
	})
	await saveNotificationAdditions(
		accessToken,
		state.notifications,
		notifications,
	).catch(() => undefined)
	return nextState
}

export async function reviewPullRequestInDriveState({
	accessToken,
	state,
	actor,
	repositoryId,
	pullRequestNumber,
}: {
	accessToken: string
	state: AppState
	actor: Actor
	repositoryId: string
	pullRequestNumber: number
}) {
	const repository = findRepository(state, repositoryId)
	const pullRequests = state.pullRequests[repositoryId] ?? []
	const pullRequest = findPullRequest(pullRequests, pullRequestNumber)
	if (pullRequest.state !== "open") {
		throw new Error("Only open pull requests can be reviewed.")
	}
	if (pullRequest.authorEmail.toLowerCase() === actor.email.toLowerCase()) {
		throw new Error("Pull request authors cannot review their own PR.")
	}
	if (!canMaintainRepository(actor, repository, "merge")) {
		throw new Error("Review permission is required.")
	}
	const now = new Date().toISOString()
	const nextState: AppState = {
		...state,
		pullRequests: {
			...state.pullRequests,
			[repositoryId]: pullRequests.map((candidate) =>
				candidate.number === pullRequestNumber
					? { ...pullRequest, reviewedBy: actor.email, updatedAt: now }
					: candidate,
			),
		},
	}
	await appendRepositoryThreadRecord({
		accessToken,
		repository,
		record: {
			schema: APP_SCHEMA.repositoryAppend,
			id: `pull-reviewed-${crypto.randomUUID()}`,
			repositoryId,
			createdAt: now,
			kind: "pull.reviewed",
			targetId: pullRequest.id,
			reviewedBy: actor.email,
			activity: [],
			notifications: {},
		},
	})
	return nextState
}

export async function closePullRequestInDriveState({
	accessToken,
	state,
	actor,
	repositoryId,
	pullRequestNumber,
}: {
	accessToken: string
	state: AppState
	actor: Actor
	repositoryId: string
	pullRequestNumber: number
}) {
	const repository = findRepository(state, repositoryId)
	const pullRequests = state.pullRequests[repositoryId] ?? []
	const pullRequest = findPullRequest(pullRequests, pullRequestNumber)
	if (pullRequest.state !== "open") {
		throw new Error("Only open pull requests can be closed.")
	}
	if (
		pullRequest.authorEmail !== actor.email &&
		!canMaintainRepository(actor, repository, "triage")
	) {
		throw new Error("Pull request close permission is required.")
	}
	const now = new Date().toISOString()
	const activity: ActivityRecord[] = [
		{
			id: `${pullRequest.id}:closed:${Date.now()}`,
			repositoryId,
			actorEmail: actor.email,
			kind: "pr.closed",
			timestamp: now,
			message: `${actor.email} closed PR #${pullRequestNumber}`,
		},
	]
	const nextState: AppState = {
		...state,
		pullRequests: {
			...state.pullRequests,
			[repositoryId]: pullRequests.map((candidate) =>
				candidate.number === pullRequestNumber
					? { ...pullRequest, state: "closed", updatedAt: now }
					: candidate,
			),
		},
		activity: [...state.activity, ...activity],
	}
	await appendRepositoryThreadRecord({
		accessToken,
		repository,
		record: {
			schema: APP_SCHEMA.repositoryAppend,
			id: `pull-closed-${crypto.randomUUID()}`,
			repositoryId,
			createdAt: now,
			kind: "pull.closed",
			targetId: pullRequest.id,
			activity,
			notifications: {},
		},
	})
	return nextState
}

async function completeRepositoryZipReplacement({
	accessToken,
	state,
	repository,
	uploadFolderId,
	repositoryZipFileId,
	repositoryZipBytes,
	baseRepositoryZipFileId,
	files,
	saveReason,
	staleMessage,
	snapshotSource,
	pullRequestNumber,
	buildNextState,
}: {
	accessToken: string
	state: AppState
	repository: RepositoryManifest
	uploadFolderId: string
	repositoryZipFileId: string
	repositoryZipBytes: number
	baseRepositoryZipFileId: string
	files: UploadedRepositoryFileMetadata[]
	saveReason: string
	staleMessage: string
	snapshotSource?: RepositorySnapshot["source"]
	pullRequestNumber?: number
	buildNextState: (input: { baseState: AppState; now: string }) => AppState
}) {
	const repositoryId = repository.id
	if (state.repositoryZipFileIds[repositoryId] !== baseRepositoryZipFileId) {
		throw new Error(staleMessage)
	}
	await assertStagedZipUpload({
		accessToken,
		fileId: repositoryZipFileId,
		folderId: uploadFolderId,
		name: APP_STORAGE.repositoryZipFileName,
		bytes: repositoryZipBytes,
	})
	const nextFiles = metadataFilesForRuntime(files, state.settings, "repository")
	const oldZipFileId = state.repositoryZipFileIds[repositoryId]
	const zipFile = await moveGoogleDriveFile({
		accessToken,
		fileId: repositoryZipFileId,
		addParentId: repository.rootFolderId,
		removeParentId: uploadFolderId,
		name: APP_STORAGE.repositoryZipFileName,
	})
	const now = new Date().toISOString()
	const baseState: AppState = {
		...state,
		repositoryFiles: { ...state.repositoryFiles, [repositoryId]: nextFiles },
		repositoryReadmeFiles: {
			...state.repositoryReadmeFiles,
			[repositoryId]: storedRepositoryFilesWithContent(
				repositoryReadmeFilesForStorage(nextFiles),
			),
		},
		repositoryZipFileIds: {
			...state.repositoryZipFileIds,
			[repositoryId]: zipFile.id,
		},
	}
	const snapshotState = snapshotSource
		? appendRepositorySnapshot(
				baseState,
				repositoryId,
				await snapshotForRepositoryZip({
					accessToken,
					zipFileId: zipFile.id,
					source: snapshotSource,
					pullRequestNumber,
				}),
			)
		: baseState
	const nextState = buildNextState({
		baseState: snapshotState,
		now,
	})
	let savedState: AppState
	try {
		savedState = await saveRepositoryState(
			accessToken,
			nextState,
			repositoryId,
			saveReason,
		)
	} catch (cause) {
		await Promise.all([
			deleteGoogleDriveFile(accessToken, zipFile.id).catch(() => undefined),
			deleteGoogleDriveFile(accessToken, uploadFolderId).catch(() => undefined),
		])
		throw cause
	}
	if (snapshotSource) await saveAppState(accessToken, savedState)
	else await saveAppState(accessToken, savedState).catch(() => undefined)
	await Promise.all([
		oldZipFileId &&
		!savedState.repositorySnapshots[repositoryId]?.some(
			(snapshot) => snapshot.driveFileId === oldZipFileId,
		)
			? deleteGoogleDriveFile(accessToken, oldZipFileId).catch(() => undefined)
			: Promise.resolve(),
		deleteGoogleDriveFile(accessToken, uploadFolderId).catch(() => undefined),
	])
	return savedState
}

export async function completePullRequestMergeUploadInDriveState({
	accessToken,
	state,
	actor,
	repositoryId,
	pullRequestNumber,
	uploadFolderId,
	repositoryZipFileId,
	repositoryZipBytes,
	baseRepositoryZipFileId,
	files,
}: {
	accessToken: string
	state: AppState
	actor: Actor
	repositoryId: string
	pullRequestNumber: number
	uploadFolderId: string
	repositoryZipFileId: string
	repositoryZipBytes: number
	baseRepositoryZipFileId: string
	files: UploadedRepositoryFileMetadata[]
}) {
	const repository = findRepository(state, repositoryId)
	const pullRequests = state.pullRequests[repositoryId] ?? []
	const pullRequest = findPullRequest(pullRequests, pullRequestNumber)
	if (pullRequest.state !== "open") {
		throw new Error("Only open pull requests can be merged.")
	}
	assertCanMergePullRequest(actor, repository, pullRequest)
	return await completeRepositoryZipReplacement({
		accessToken,
		state,
		repository,
		uploadFolderId,
		repositoryZipFileId,
		repositoryZipBytes,
		baseRepositoryZipFileId,
		files,
		saveReason: "pull.merge",
		staleMessage: "Repository changed before the merge was committed.",
		snapshotSource: "pull_request.merged",
		pullRequestNumber,
		buildNextState: ({ baseState, now }) => ({
			...baseState,
			repositories: state.repositories.map((candidate) =>
				candidate.id === repositoryId
					? { ...candidate, updatedAt: now }
					: candidate,
			),
			pullRequests: {
				...state.pullRequests,
				[repositoryId]: pullRequests.map((candidate) =>
					candidate.number === pullRequestNumber
						? { ...pullRequest, state: "merged", updatedAt: now }
						: candidate,
				),
			},
			activity: [
				...state.activity,
				{
					id: `${pullRequest.id}:merged:${Date.now()}`,
					repositoryId,
					actorEmail: actor.email,
					kind: "pr.merged",
					timestamp: now,
					message: `${actor.email} merged PR #${pullRequestNumber}`,
				},
			],
		}),
	})
}

export async function completeGitHubMirrorSyncUploadInDriveState({
	accessToken,
	state,
	actorEmail,
	repositoryId,
	uploadFolderId,
	repositoryZipFileId,
	repositoryZipBytes,
	baseRepositoryZipFileId,
	files,
	githubMirror,
}: {
	accessToken: string
	state: AppState
	actorEmail: string
	repositoryId: string
	uploadFolderId: string
	repositoryZipFileId: string
	repositoryZipBytes: number
	baseRepositoryZipFileId: string
	files: UploadedRepositoryFileMetadata[]
	githubMirror: NonNullable<RepositoryManifest["githubMirror"]>
}) {
	const repository = findRepository(state, repositoryId)
	if (!repository.githubMirror)
		throw new Error("Repository is not a GitHub mirror.")
	return await completeRepositoryZipReplacement({
		accessToken,
		state,
		repository,
		uploadFolderId,
		repositoryZipFileId,
		repositoryZipBytes,
		baseRepositoryZipFileId,
		files,
		saveReason: "github.mirror.sync",
		staleMessage: "Repository changed before the GitHub sync was committed.",
		snapshotSource: "repository.synced",
		buildNextState: ({ baseState, now }) => ({
			...baseState,
			repositories: state.repositories.map((candidate) =>
				candidate.id === repositoryId
					? {
							...candidate,
							githubMirror: {
								...githubMirror,
								lastSyncedAt: now,
								lastSyncStatus: "ok",
								lastSyncError: undefined,
							},
							updatedAt: now,
						}
					: candidate,
			),
			activity: [
				...state.activity,
				{
					id: `${repository.id}:github.synced:${Date.now()}`,
					repositoryId,
					actorEmail,
					kind: "repo.synced",
					timestamp: now,
					message: `${actorEmail} refreshed ${repository.owner}/${repository.name} from GitHub`,
				},
			],
		}),
	})
}

async function createZipDownloadCopy({
	accessToken,
	state,
	sourceFileId,
	name,
	label,
	browserApiKey,
}: {
	accessToken: string
	state: AppState
	sourceFileId: string
	name: string
	label: string
	browserApiKey?: string
}): Promise<ZipDownloadLink> {
	if (!browserApiKey) {
		throw new Error(
			"GOOGLE_DRIVE_BROWSER_API_KEY is required for ZIP downloads.",
		)
	}
	await sweepStaleZipDownloadFolders({ accessToken, state }).catch(
		() => undefined,
	)
	const folder = await createGoogleDriveFolder({
		accessToken,
		parentId: state.rootFolder.id,
		name: stagedDownloadFolderName(label),
	})
	try {
		const file = await copyGoogleDriveFile({
			accessToken,
			fileId: sourceFileId,
			parentId: folder.id,
			name,
		})
		const permission = await createGoogleDriveAnyoneReaderPermission(
			accessToken,
			file.id,
		)
		return {
			name,
			fetchUrl: googleDrivePublicFileMediaUrl(file.id, browserApiKey),
			fileId: file.id,
			folderId: folder.id,
			permissionId: permission.id,
		}
	} catch (cause) {
		await deleteGoogleDriveFile(accessToken, folder.id).catch(() => undefined)
		throw cause
	}
}

export async function createRepositoryZipDownloadLink({
	accessToken,
	state,
	repositoryId,
	browserApiKey,
}: {
	accessToken: string
	state: AppState
	repositoryId: string
	browserApiKey?: string
}) {
	const repository = findRepository(state, repositoryId)
	const repositoryZipFileId = state.repositoryZipFileIds[repositoryId]
	if (!repositoryZipFileId) throw new Error("Repository ZIP is missing.")
	return await createZipDownloadCopy({
		accessToken,
		state,
		sourceFileId: repositoryZipFileId,
		name: `${repository.owner}-${repository.name}.zip`,
		label: `${repository.owner}-${repository.name}`,
		browserApiKey,
	})
}

export async function createPullRequestZipDownloadLink({
	accessToken,
	state,
	repositoryId,
	pullRequestNumber,
	browserApiKey,
}: {
	accessToken: string
	state: AppState
	repositoryId: string
	pullRequestNumber: number
	browserApiKey?: string
}) {
	const repository = findRepository(state, repositoryId)
	const pullRequest = findPullRequest(
		state.pullRequests[repositoryId] ?? [],
		pullRequestNumber,
	)
	const zipFileId = state.pullRequestZipFileIds[pullRequest.id]
	if (!zipFileId) throw new Error("Pull request ZIP is missing.")
	return await createZipDownloadCopy({
		accessToken,
		state,
		sourceFileId: zipFileId,
		name: `${repository.owner}-${repository.name}-pr-${pullRequestNumber}.zip`,
		label: `${repository.owner}-${repository.name}-pr-${pullRequestNumber}`,
		browserApiKey,
	})
}

export async function revokeZipDownloadLink({
	accessToken,
	fileId,
	folderId,
	permissionId,
}: {
	accessToken: string
	fileId: string
	folderId: string
	permissionId: string
}) {
	await deleteGoogleDrivePermission({
		accessToken,
		fileId,
		permissionId,
	}).catch(() => undefined)
	await deleteGoogleDriveFile(accessToken, fileId).catch(() => undefined)
	await deleteGoogleDriveFile(accessToken, folderId).catch(() => undefined)
}

export async function connectBackupDrive({
	ownerAccessToken,
	state,
	actorEmail,
	backupAccessToken,
	backupRefreshToken,
	accountEmail,
}: {
	ownerAccessToken: string
	state: AppState
	actorEmail: string
	backupAccessToken: string
	backupRefreshToken: string
	accountEmail: string
}) {
	const normalizedEmail = accountEmail.trim().toLowerCase()
	const now = new Date().toISOString()
	const existingTarget = state.settings.backupTargets.find(
		(target) => target.accountEmail.toLowerCase() === normalizedEmail,
	)
	const targetId = existingTarget?.id ?? `backup-${crypto.randomUUID()}`
	const credentialRef =
		existingTarget?.credentialRef ?? `credential-${crypto.randomUUID()}`
	const target: BackupDriveTarget = {
		id: targetId,
		provider: "google-drive",
		accountEmail: normalizedEmail,
		rootFolderId: existingTarget?.rootFolderId ?? targetId,
		enabled: true,
		credentialRef,
		lastSyncAt: now,
		lastSyncStatus: "pending",
	}
	const nextState: AppState = {
		...state,
		settings: {
			...state.settings,
			backupTargets: [
				...state.settings.backupTargets.filter(
					(candidate) => candidate.id !== targetId,
				),
				target,
			].sort((left, right) =>
				left.accountEmail.localeCompare(right.accountEmail),
			),
			updatedAt: now,
			updatedBy: actorEmail,
		},
		backupCredentials: {
			...state.backupCredentials,
			[credentialRef]: {
				id: credentialRef,
				provider: "google-drive",
				accountEmail: normalizedEmail,
				refreshToken: backupRefreshToken,
				createdAt: state.backupCredentials[credentialRef]?.createdAt ?? now,
				updatedAt: now,
			},
		},
		activity: [
			...state.activity,
			{
				id: `backup.connected:${targetId}:${Date.now()}`,
				repositoryId: "settings",
				actorEmail,
				kind: "settings.updated",
				timestamp: now,
				message: `${actorEmail} connected backup Drive ${normalizedEmail}`,
			},
		],
	}
	await saveAppState(ownerAccessToken, nextState)
	void (async () => {
		try {
			const backupState = await mirrorStateToBackupDrive({
				sourceState: nextState,
				ownerAccessToken,
				backupAccessToken,
				previousRootFolderId: existingTarget?.rootFolderId,
			})
			await saveBackupTargetUpdates({
				accessToken: ownerAccessToken,
				state: nextState,
				actorEmail,
				updates: [
					{
						targetId,
						patch: {
							rootFolderId: backupState.rootFolder.id,
							lastSyncAt: new Date().toISOString(),
							lastSyncStatus: "ok",
						},
					},
				],
			})
		} catch {
			await saveBackupTargetUpdates({
				accessToken: ownerAccessToken,
				state: nextState,
				actorEmail,
				updates: [
					{
						targetId,
						patch: {
							lastSyncAt: new Date().toISOString(),
							lastSyncStatus: "failed",
						},
					},
				],
			}).catch(() => undefined)
		}
	})()
	return nextState
}

export async function disconnectBackupDrive({
	accessToken,
	state,
	actorEmail,
	targetId,
}: {
	accessToken: string
	state: AppState
	actorEmail: string
	targetId: string
}) {
	const target = findBackupTarget(state, targetId)
	const now = new Date().toISOString()
	const nextState: AppState = {
		...state,
		settings: {
			...state.settings,
			backupTargets: state.settings.backupTargets.filter(
				(candidate) => candidate.id !== targetId,
			),
			updatedAt: now,
			updatedBy: actorEmail,
		},
		backupCredentials: omitRecordKey(
			state.backupCredentials,
			target.credentialRef,
		),
		activity: [
			...state.activity,
			{
				id: `backup.disconnected:${targetId}:${Date.now()}`,
				repositoryId: "settings",
				actorEmail,
				kind: "settings.updated",
				timestamp: now,
				message: `${actorEmail} disconnected backup Drive ${target.accountEmail}`,
			},
		],
	}
	await saveAppState(accessToken, nextState)
	return nextState
}

export async function deleteBackupDrive({
	ownerAccessToken,
	state,
	actorEmail,
	targetId,
	backupAccessToken,
}: {
	ownerAccessToken: string
	state: AppState
	actorEmail: string
	targetId: string
	backupAccessToken: string
}) {
	const target = findBackupTarget(state, targetId)
	await deleteGoogleDriveFile(backupAccessToken, target.rootFolderId).catch(
		() => undefined,
	)
	await deleteGoogleDriveAppDataDocument(backupAccessToken).catch(
		() => undefined,
	)
	return await disconnectBackupDrive({
		accessToken: ownerAccessToken,
		state,
		actorEmail,
		targetId,
	})
}

export async function syncConnectedBackupDrives({
	ownerAccessToken,
	state,
	actorEmail,
	resolveBackupAccessToken,
	force = false,
}: {
	ownerAccessToken: string
	state: AppState
	actorEmail: string
	resolveBackupAccessToken: (refreshToken: string) => Promise<string>
	force?: boolean
}) {
	const enabledTargets = backupTargetsDueForSync(state, force)
	if (!enabledTargets.length) return state

	const startedAt = new Date().toISOString()
	const pendingUpdates = enabledTargets.map((target) => ({
		targetId: target.id,
		patch: {
			lastSyncAt: startedAt,
			lastSyncStatus: "pending",
		} satisfies Partial<BackupDriveTarget>,
	}))
	let nextState = pendingUpdates.reduce(
		(next, update) => updateBackupTarget(next, update.targetId, update.patch),
		state,
	)
	await saveBackupTargetUpdates({
		accessToken: ownerAccessToken,
		state,
		actorEmail,
		updates: pendingUpdates,
	}).catch(() => undefined)

	const updates: Array<{
		targetId: string
		patch: Partial<BackupDriveTarget>
	}> = []
	for (const target of enabledTargets) {
		const credential = nextState.backupCredentials[target.credentialRef]
		if (!credential) {
			continue
		}

		try {
			const backupAccessToken = await resolveBackupAccessToken(
				credential.refreshToken,
			)
			const backupState = await mirrorStateToBackupDrive({
				sourceState: nextState,
				ownerAccessToken,
				backupAccessToken,
				previousRootFolderId: target.rootFolderId,
			})
			const patch = {
				rootFolderId: backupState.rootFolder.id,
				lastSyncAt: new Date().toISOString(),
				lastSyncStatus: "ok",
			} satisfies Partial<BackupDriveTarget>
			updates.push({ targetId: target.id, patch })
			nextState = updateBackupTarget(nextState, target.id, patch)
		} catch {
			const patch = {
				lastSyncAt: new Date().toISOString(),
				lastSyncStatus: "failed",
			} satisfies Partial<BackupDriveTarget>
			updates.push({ targetId: target.id, patch })
			nextState = updateBackupTarget(nextState, target.id, patch)
		}
	}
	if (updates.length) {
		await saveBackupTargetUpdates({
			accessToken: ownerAccessToken,
			state,
			actorEmail,
			updates,
		}).catch(() => undefined)
	}

	return nextState
}

async function copyZipArtifactToBackupDrive({
	ownerAccessToken,
	backupAccessToken,
	sourceFileId,
	parentId,
	name,
}: {
	ownerAccessToken: string
	backupAccessToken: string
	sourceFileId: string
	parentId: string
	name: string
}) {
	const permission = await createGoogleDriveAnyoneReaderPermission(
		ownerAccessToken,
		sourceFileId,
	)
	try {
		return await timed(
			"drive.backup.artifact.copy",
			() =>
				copyGoogleDriveFile({
					accessToken: backupAccessToken,
					fileId: sourceFileId,
					parentId,
					name,
				}),
			{ sourceFileId, parentId, name },
		)
	} finally {
		await deleteGoogleDrivePermission({
			accessToken: ownerAccessToken,
			fileId: sourceFileId,
			permissionId: permission.id,
		}).catch(() => undefined)
	}
}

async function mirrorStateToBackupDrive({
	sourceState,
	ownerAccessToken,
	backupAccessToken,
	previousRootFolderId,
}: {
	sourceState: AppState
	ownerAccessToken: string
	backupAccessToken: string
	previousRootFolderId?: string
}) {
	if (previousRootFolderId) {
		await deleteGoogleDriveFile(backupAccessToken, previousRootFolderId).catch(
			() => undefined,
		)
	}
	const rootFolder = await ensureGoogleDriveResultsFolder(backupAccessToken)
	const repositoryZipFileIds: Record<string, string> = {}
	const repositorySnapshots: Record<string, RepositorySnapshot[]> = {}
	const pullRequestZipFileIds: Record<string, string> = {}
	const repositories: RepositoryManifest[] = []

	for (const repository of sourceState.repositories) {
		const repoFolder = await createGoogleDriveFolder({
			accessToken: backupAccessToken,
			name: `${repository.owner}-${repository.name}`,
			parentId: rootFolder.id,
		})
		const repositoryZipFileId = sourceState.repositoryZipFileIds[repository.id]
		if (!repositoryZipFileId) {
			throw new Error(`Repository ZIP is missing: ${repository.id}`)
		}
		const zipFile = await copyZipArtifactToBackupDrive({
			ownerAccessToken,
			backupAccessToken,
			sourceFileId: repositoryZipFileId,
			parentId: repoFolder.id,
			name: APP_STORAGE.repositoryZipFileName,
		})
		const backupManifest = {
			...repository,
			rootFolderId: repoFolder.id,
		}
		await uploadFileToGoogleDrive({
			accessToken: backupAccessToken,
			parentId: repoFolder.id,
			name: APP_STORAGE.repositoryManifestFileName,
			blob: new Blob([JSON.stringify(backupManifest, null, 2)], {
				type: "application/json",
			}),
		})
		repositories.push(backupManifest)
		repositoryZipFileIds[repository.id] = zipFile.id
		repositorySnapshots[repository.id] = []
		for (const snapshot of sourceState.repositorySnapshots[repository.id] ??
			[]) {
			const snapshotFile =
				snapshot.driveFileId === repositoryZipFileId
					? zipFile
					: await copyZipArtifactToBackupDrive({
							ownerAccessToken,
							backupAccessToken,
							sourceFileId: snapshot.driveFileId,
							parentId: repoFolder.id,
							name: `snapshot-${snapshot.revision}.zip`,
						})
			repositorySnapshots[repository.id].push({
				...snapshot,
				driveFileId: snapshotFile.id,
			})
		}

		for (const pullRequest of sourceState.pullRequests[repository.id] ?? []) {
			const pullRequestArtifactName = `${APP_STORAGE.pullRequestFolderPrefix}-${pullRequest.number}`
			const prFolder = await createGoogleDriveFolder({
				accessToken: backupAccessToken,
				name: pullRequestArtifactName,
				parentId: repoFolder.id,
			})
			const pullRequestZipFileId =
				sourceState.pullRequestZipFileIds[pullRequest.id]
			if (!pullRequestZipFileId) continue
			const prZip = await copyZipArtifactToBackupDrive({
				ownerAccessToken,
				backupAccessToken,
				sourceFileId: pullRequestZipFileId,
				parentId: prFolder.id,
				name: `${pullRequestArtifactName}.zip`,
			})
			pullRequestZipFileIds[pullRequest.id] = prZip.id
		}
	}

	const backupState: AppState = {
		...sourceState,
		config: createBootstrapConfig(rootFolder.id, rootFolder.webViewLink ?? ""),
		rootFolder,
		repositories,
		repositoryZipFileIds,
		repositorySnapshots,
		pullRequestZipFileIds,
		backupCredentials: {},
		settings: {
			...sourceState.settings,
			backupTargets: [],
		},
	}
	let savedBackupState = backupState
	for (const repository of backupState.repositories) {
		savedBackupState = await saveRepositoryState(
			backupAccessToken,
			savedBackupState,
			repository.id,
			"backup.mirror",
		)
	}
	await saveAppState(backupAccessToken, savedBackupState)
	return savedBackupState
}

function findRepository(state: AppState, repositoryId: string) {
	const repository = state.repositories.find((repo) => repo.id === repositoryId)
	if (!repository) throw new Error(`Repository not found: ${repositoryId}`)
	return repository
}

function canEditThreadTitle(
	actor: Actor,
	repository: RepositoryManifest,
	authorEmail: string,
) {
	if (authorEmail.toLowerCase() === actor.email.toLowerCase()) return true
	if (canMaintainRepository(actor, repository, "triage")) return true
	return repository.maintainers.some(
		(maintainer) =>
			maintainer.email.toLowerCase() === actor.email.toLowerCase(),
	)
}

function findBackupTarget(state: AppState, targetId: string) {
	const target = state.settings.backupTargets.find(
		(candidate) => candidate.id === targetId,
	)
	if (!target) throw new Error(`Backup Drive not found: ${targetId}`)
	return target
}

function updateBackupTarget(
	state: AppState,
	targetId: string,
	patch: Partial<BackupDriveTarget>,
) {
	return {
		...state,
		settings: {
			...state.settings,
			backupTargets: state.settings.backupTargets.map((target) =>
				target.id === targetId ? { ...target, ...patch } : target,
			),
		},
	}
}

export function hasDueBackupSync(state: AppState, force = false) {
	return backupTargetsDueForSync(state, force).length > 0
}

function backupTargetsDueForSync(state: AppState, force: boolean) {
	const enabledTargets = state.settings.backupTargets.filter(
		(target) => target.enabled,
	)
	if (force) return enabledTargets
	const intervalMs = backupSyncIntervalMs(state.settings)
	if (intervalMs === null) return []
	const now = Date.now()
	return enabledTargets.filter((target) =>
		isBackupTargetDue(target, intervalMs, now),
	)
}

function backupSyncIntervalMs(settings: AppSettings) {
	if (settings.backupSyncIntervalHours <= 0) return null
	return settings.backupSyncIntervalHours * APP_TIMING.msPerHour
}

function isBackupTargetDue(
	target: BackupDriveTarget,
	intervalMs: number,
	now: number,
) {
	if (!target.lastSyncAt) return true
	const lastSyncAt = Date.parse(target.lastSyncAt)
	if (!Number.isFinite(lastSyncAt)) return true
	return now - lastSyncAt >= intervalMs
}

async function saveBackupTargetUpdates({
	accessToken,
	state,
	actorEmail,
	updates,
}: {
	accessToken: string
	state: AppState
	actorEmail: string
	updates: Array<{ targetId: string; patch: Partial<BackupDriveTarget> }>
}) {
	let lastError: unknown
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const currentState =
			attempt === 0
				? state
				: await loadOrCreateAppState(accessToken, actorEmail, {
						includeRepositoryDetails: false,
					})
		const nextState = updates.reduce(
			(next, update) => updateBackupTarget(next, update.targetId, update.patch),
			currentState,
		)
		try {
			await saveAppState(accessToken, nextState)
			return nextState
		} catch (cause) {
			lastError = cause
			if (!isStorageConflict(cause)) throw cause
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error("Backup sync status save failed.")
}

function moveRepositoryRecord<T>(
	record: Record<string, T>,
	fromRepositoryId: string,
	toRepositoryId: string,
) {
	if (fromRepositoryId === toRepositoryId || !(fromRepositoryId in record)) {
		return record
	}
	const { [fromRepositoryId]: value, ...rest } = record
	return {
		...rest,
		[toRepositoryId]: value,
	}
}

function findIssue(issues: IssueRecord[], issueNumber: number) {
	const issue = issues.find((candidate) => candidate.number === issueNumber)
	if (!issue) throw new Error(`Issue not found: #${issueNumber}`)
	return issue
}

function findPullRequest(
	pullRequests: AppPullRequest[],
	pullRequestNumber: number,
) {
	const pullRequest = pullRequests.find(
		(candidate) => candidate.number === pullRequestNumber,
	)
	if (!pullRequest) {
		throw new Error(`Pull request not found: #${pullRequestNumber}`)
	}
	return pullRequest
}

function ensureUserProfile(state: AppState, email: string, now: string) {
	const normalizedEmail = email.trim().toLowerCase()
	if (!normalizedEmail) return state
	const existingUser = state.users[normalizedEmail]
	if (existingUser) {
		return state
	}
	const ownerName = uniqueOwnerName(state.settings.ownerName, state.users)
	return {
		...state,
		users: {
			...state.users,
			[normalizedEmail]: {
				email: normalizedEmail,
				ownerName,
				createdAt: now,
				updatedAt: now,
			},
		},
		notifications: {
			...state.notifications,
			[normalizedEmail]: state.notifications[normalizedEmail] ?? [],
		},
	}
}

function normalizeOwnerName(ownerName: string) {
	const normalized = ownerName.trim().replace(/\s+/g, " ")
	if (!normalized) throw new Error("Name is required.")
	if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(normalized)) {
		throw new Error(
			"Name may contain letters, numbers, spaces, dots, underscores, and hyphens, and must start with a letter or number.",
		)
	}
	return normalized
}

function uniqueOwnerName(baseName: string, users: Record<string, UserProfile>) {
	const used = new Set(
		Object.values(users).map((user) => user.ownerName.toLowerCase()),
	)
	if (!used.has(baseName.toLowerCase())) return baseName
	for (let index = 2; index < 1000; index += 1) {
		const candidate = `${baseName}-${index}`
		if (!used.has(candidate.toLowerCase())) return candidate
	}
	return `${baseName}-${Date.now()}`
}

function uniqueNormalizedEmails(emails: string[]) {
	return [
		...new Set(
			emails
				.map((email) => email.trim().toLowerCase())
				.filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)),
		),
	]
}

function addMentionNotifications({
	state,
	repositoryId,
	sourceId,
	actorEmail,
	text,
	message,
	now,
}: {
	state: AppState
	repositoryId: string
	sourceId: string
	actorEmail: string
	text: string
	message: string
	now: string
}) {
	let nextNotifications = state.notifications
	for (const user of resolveMentionedUsers(text, state.users)) {
		if (!user) continue
		if (nextNotifications === state.notifications) {
			nextNotifications = { ...state.notifications }
		}
		const current = nextNotifications[user.email] ?? []
		nextNotifications[user.email] = [
			...current,
			{
				id: `${sourceId}:mention:${user.email}:${Date.now()}`,
				repositoryId,
				recipientEmail: user.email,
				actorEmail,
				sourceId,
				message,
				createdAt: now,
				read: false,
			},
		]
	}
	return nextNotifications
}

export function resolveMentionedUsers(
	text: string,
	users: Record<string, UserProfile>,
) {
	const tokenMentions = new Set(extractMentions(text))
	const mentioned = new Map<string, UserProfile>()
	for (const user of Object.values(users)) {
		const aliases = mentionAliases(user.ownerName)
		if (
			aliases.some(
				(alias) =>
					tokenMentions.has(alias.toLowerCase()) ||
					containsMentionPhrase(text, alias),
			)
		) {
			mentioned.set(user.email, user)
		}
	}
	return [...mentioned.values()]
}

function mentionAliases(ownerName: string) {
	const trimmed = ownerName.trim()
	const dashed = trimmed.replace(/\s+/g, "-")
	const compact = trimmed.replace(/\s+/g, "")
	const handle = trimmed
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
	return [...new Set([trimmed, dashed, compact, handle].filter(Boolean))]
}

function containsMentionPhrase(text: string, alias: string) {
	const source = text.toLowerCase()
	const target = `@${alias.toLowerCase()}`
	let index = source.indexOf(target)
	while (index !== -1) {
		const after = source[index + target.length]
		if (!after || /[\s.,;:!?()[\]{}<>"'`]/.test(after)) return true
		index = source.indexOf(target, index + 1)
	}
	return false
}

function remapRecordKeys<T>(
	record: Record<string, T>,
	remap: (key: string) => string,
) {
	return Object.fromEntries(
		Object.entries(record).map(([key, value]) => [remap(key), value]),
	)
}

function omitRecordKey<T>(record: Record<string, T>, keyToOmit: string) {
	return Object.fromEntries(
		Object.entries(record).filter(([key]) => key !== keyToOmit),
	)
}
