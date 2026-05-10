import { APP_DOWNLOAD, APP_TIMING } from "./app-config"
import type { DownloadFile } from "./download-client"
import type { AppState, UploadProgress } from "./drive-state"
import { assertDriveQuotaAllowsUpload } from "./drive-quota"
import { fetchGitHubRepositorySnapshot } from "./github"
import {
	applyPullRequestFiles,
	compactPullRequestChanges,
	diffRepositoryFiles,
	type FileDiff,
} from "./pulls"
import { filesForDownload } from "./repositories"
import { prepareRepositoryUploadFiles } from "./repositories/uploads"
import type { GitHubMirror, RepositoryFile } from "./types"
import {
	buildClientZipBlob,
	clientUploadMetadata,
	prepareClientUploadArchive,
	prepareClientUploadSnapshot,
	pullRequestBaseSidecarMetadata,
	repositoryFilesFromZipBlob,
	uploadBlobToGoogleDriveSession,
	type ClientUploadFileMetadata,
} from "./upload-client"

export type BeginZipUploadData =
	| {
			kind: "repository"
			name: string
			zipBytes: number
			origin: string
	  }
	| {
			kind: "pull-request"
			repositoryId: string
			repositoryRootFolderId?: string
			baseRepositoryZipFileId: string
			zipBytes: number
			origin: string
	  }
	| {
			kind: "pull-merge"
			repositoryId: string
			repositoryRootFolderId?: string
			pullRequestNumber: number
			baseRepositoryZipFileId: string
			zipBytes: number
			origin: string
	  }
	| {
			kind: "github-mirror-sync"
			repositoryId: string
			repositoryRootFolderId?: string
			baseRepositoryZipFileId: string
			zipBytes: number
			origin: string
	  }

type ZipUploadStart = {
	uploadUrl: string
	uploadTicket: string
	repositoryRootFolderId?: string
	uploadFolderId?: string
}

type ZipPayload = {
	name: string
	fetchUrl: string
	downloadTicket: string
}

export type ClientZipWorkflowContext = {
	getState: () => AppState | null
	setState: (updater: (current: AppState | null) => AppState | null) => void
	setProgress: (progress: UploadProgress | null) => void
	getRepositoryRootFolderId: (repositoryId: string) => string | undefined
	getOrigin: () => string
	beginZipUpload: (data: BeginZipUploadData) => Promise<ZipUploadStart>
	cancelZipUpload: (uploadTicket: string) => Promise<unknown>
	revokeZipDownload: (downloadTicket: string) => Promise<unknown>
	completeRepositoryUpload: (data: {
		name: string
		description?: string
		repositoryZipFileId: string
		uploadTicket: string
		files: ClientUploadFileMetadata[]
		githubMirror?: GitHubMirror
	}) => Promise<AppState>
	completePullRequestUpload: (data: {
		repositoryId: string
		repositoryRootFolderId?: string
		title: string
		body: string
		uploadZipFileId: string
		uploadTicket: string
		files: ClientUploadFileMetadata[]
		baseFiles: ClientUploadFileMetadata[]
		diff: FileDiff[]
	}) => Promise<AppState>
	completePullRequestMergeUpload: (data: {
		repositoryId: string
		repositoryRootFolderId?: string
		pullRequestNumber: number
		repositoryZipFileId: string
		uploadTicket: string
		files: ClientUploadFileMetadata[]
	}) => Promise<AppState>
	completeGitHubMirrorSyncUpload: (data: {
		repositoryId: string
		repositoryRootFolderId?: string
		repositoryZipFileId: string
		uploadTicket: string
		files: ClientUploadFileMetadata[]
		githubMirror: GitHubMirror
	}) => Promise<AppState>
	downloadRepositoryZip: (data: {
		repositoryId: string
		repositoryRootFolderId?: string
	}) => Promise<ZipPayload>
	downloadPullRequestZip: (data: {
		repositoryId: string
		repositoryRootFolderId?: string
		pullRequestNumber: number
	}) => Promise<ZipPayload>
}

type ZipSnapshot = {
	zipFileId?: string
	files: RepositoryFile[]
	blob: Blob
}

export type ClientZipWorkflowCache = {
	repositoryZips: Map<string, ZipSnapshot>
	pullRequestZips: Map<string, ZipSnapshot>
}

export function createClientZipWorkflowCache(): ClientZipWorkflowCache {
	return {
		repositoryZips: new Map(),
		pullRequestZips: new Map(),
	}
}

export async function uploadRepositoryFromFolder({
	context,
	files,
	name,
	description,
}: {
	context: ClientZipWorkflowContext
	files: File[]
	name: string
	description?: string
}) {
	const state = requireState(context)
	const archive = await prepareClientUploadArchive({
		files,
		settings: state.settings,
		kind: "repository",
		onProgress: context.setProgress,
	})
	const { uploadTicket, zipFile } = await uploadPreparedArchiveToDrive(
		context,
		{
			kind: "repository",
			name,
			zipBytes: archive.blob.size,
			origin: context.getOrigin(),
		},
		archive.blob,
	)
	return await context.completeRepositoryUpload({
		name,
		description,
		repositoryZipFileId: zipFile.id,
		uploadTicket,
		files: archive.files,
	})
}

export async function uploadRepositoryFromGitHub({
	context,
	name,
	description,
	githubUrl,
}: {
	context: ClientZipWorkflowContext
	name: string
	description?: string
	githubUrl: string
}) {
	const state = requireState(context)
	if (!state.settings.allowPublicGitMirrors) {
		throw new Error("Public GitHub mirrors are disabled.")
	}
	context.setProgress({
		phase: "preparing",
		current: 0,
		total: 1,
		message: "Fetching GitHub repository files",
	})
	const snapshot = await fetchGitHubRepositorySnapshot(
		githubUrl,
		context.setProgress,
	)
	const repositoryFiles = prepareRepositoryUploadFiles(
		snapshot.files,
		state.settings,
		"repository",
	)
	const blob = await buildClientZipBlob({
		files: repositoryFiles,
		onProgress: context.setProgress,
	})
	const { uploadTicket, zipFile } = await uploadPreparedArchiveToDrive(
		context,
		{
			kind: "repository",
			name,
			zipBytes: blob.size,
			origin: context.getOrigin(),
		},
		blob,
	)
	return await context.completeRepositoryUpload({
		name,
		description,
		repositoryZipFileId: zipFile.id,
		uploadTicket,
		files: clientUploadMetadata(repositoryFiles, { includeSidecars: true }),
		githubMirror: snapshot.mirror,
	})
}

export async function createPullRequestFromFolder({
	context,
	cache,
	repositoryId,
	title,
	body,
	files,
}: {
	context: ClientZipWorkflowContext
	cache: ClientZipWorkflowCache
	repositoryId: string
	title: string
	body: string
	files: File[]
}) {
	const state = requireState(context)
	const baseSnapshot = await loadRepositoryZipSnapshot(
		context,
		cache,
		repositoryId,
	)
	const uploadSnapshot = await prepareClientUploadSnapshot({
		files,
		settings: state.settings,
		kind: "pull-request",
		onProgress: context.setProgress,
	})
	const diff = diffRepositoryFiles(
		baseSnapshot.files,
		uploadSnapshot.files,
	).filter((fileDiff) => fileDiff.status !== "unchanged")
	const changedFiles = compactPullRequestChanges(
		baseSnapshot.files,
		uploadSnapshot.files,
	)
	if (!diff.length) throw new Error("Pull request has no changes.")
	if (!baseSnapshot.zipFileId) throw new Error("Repository ZIP is missing.")
	const baseDiffPaths = new Set(
		diff
			.filter((fileDiff) => fileDiff.status !== "added")
			.map((fileDiff) => fileDiff.path),
	)
	const baseFiles = baseSnapshot.files.filter((file) =>
		baseDiffPaths.has(file.path),
	)
	const blob = await buildClientZipBlob({
		files: changedFiles,
		onProgress: context.setProgress,
	})
	const repositoryRootFolderId = context.getRepositoryRootFolderId(repositoryId)
	const { uploadTicket, zipFile } = await uploadPreparedArchiveToDrive(
		context,
		{
			kind: "pull-request",
			repositoryId,
			repositoryRootFolderId,
			baseRepositoryZipFileId: baseSnapshot.zipFileId,
			zipBytes: blob.size,
			origin: context.getOrigin(),
		},
		blob,
	)
	return await context.completePullRequestUpload({
		repositoryId,
		repositoryRootFolderId,
		title,
		body,
		uploadZipFileId: zipFile.id,
		uploadTicket,
		files: clientUploadMetadata(changedFiles),
		baseFiles: pullRequestBaseSidecarMetadata(baseFiles),
		diff,
	})
}

export async function mergePullRequestWithClientZip({
	context,
	cache,
	repositoryId,
	pullRequestNumber,
}: {
	context: ClientZipWorkflowContext
	cache: ClientZipWorkflowCache
	repositoryId: string
	pullRequestNumber: number
}) {
	const state = requireState(context)
	const baseSnapshot = await loadRepositoryZipSnapshot(
		context,
		cache,
		repositoryId,
	)
	if (!baseSnapshot.zipFileId) throw new Error("Repository ZIP is missing.")
	const pullRequest = findPullRequestByNumber(
		state,
		repositoryId,
		pullRequestNumber,
	)
	const pullSnapshot = await loadPullRequestZipSnapshot(
		context,
		cache,
		repositoryId,
		pullRequestNumber,
	)
	const mergedFiles = applyPullRequestFiles(baseSnapshot.files, {
		...pullRequest,
		files: pullSnapshot.files,
	})
	const exportFiles = filesForDownload(mergedFiles)
	const blob = await buildClientZipBlob({
		files: exportFiles,
		onProgress: context.setProgress,
	})
	const repositoryRootFolderId = context.getRepositoryRootFolderId(repositoryId)
	const { uploadTicket, zipFile } = await uploadPreparedArchiveToDrive(
		context,
		{
			kind: "pull-merge",
			repositoryId,
			repositoryRootFolderId,
			pullRequestNumber,
			baseRepositoryZipFileId: baseSnapshot.zipFileId,
			zipBytes: blob.size,
			origin: context.getOrigin(),
		},
		blob,
	)
	const nextState = await context.completePullRequestMergeUpload({
		repositoryId,
		repositoryRootFolderId,
		pullRequestNumber,
		repositoryZipFileId: zipFile.id,
		uploadTicket,
		files: clientUploadMetadata(exportFiles, { includeSidecars: true }),
	})
	cache.repositoryZips.delete(repositoryId)
	return nextState
}

export async function downloadRepositoryZipFile(
	context: ClientZipWorkflowContext,
	repositoryId: string,
) {
	return await zipBlobFromResult(
		context,
		await context.downloadRepositoryZip({
			repositoryId,
			repositoryRootFolderId: context.getRepositoryRootFolderId(repositoryId),
		}),
	)
}

export async function downloadPullRequestPreviewZipFile({
	context,
	cache,
	repositoryId,
	pullRequestNumber,
}: {
	context: ClientZipWorkflowContext
	cache: ClientZipWorkflowCache
	repositoryId: string
	pullRequestNumber: number
}) {
	const state = requireState(context)
	const baseSnapshot = await loadRepositoryZipSnapshot(
		context,
		cache,
		repositoryId,
	)
	const pullRequest = findPullRequestByNumber(
		state,
		repositoryId,
		pullRequestNumber,
	)
	if (pullRequest.state !== "open") {
		throw new Error("Only open pull requests can be downloaded before merge.")
	}
	const pullSnapshot = await loadPullRequestZipSnapshot(
		context,
		cache,
		repositoryId,
		pullRequestNumber,
	)
	const mergedFiles = applyPullRequestFiles(baseSnapshot.files, {
		...pullRequest,
		files: pullSnapshot.files,
	})
	return {
		blob: await buildClientZipBlob({ files: filesForDownload(mergedFiles) }),
		name: `${repositoryId.replaceAll("/", "-")}-pr-${pullRequestNumber}-merged.zip`,
	} satisfies DownloadFile
}

export async function loadPullRequestZipSnapshot(
	context: ClientZipWorkflowContext,
	cache: ClientZipWorkflowCache,
	repositoryId: string,
	pullRequestNumber: number,
	state: AppState | null = context.getState(),
) {
	if (!state) throw new Error("Repository state is still loading.")
	const pullRequest = findPullRequestByNumber(
		state,
		repositoryId,
		pullRequestNumber,
	)
	const zipFileId = state.pullRequestZipFileIds[pullRequest.id]
	const cached = cache.pullRequestZips.get(pullRequest.id)
	if (cached && cached.zipFileId === zipFileId) {
		storePullRequestFiles(context, repositoryId, pullRequest.id, cached.files)
		return cached
	}
	const result = await context.downloadPullRequestZip({
		repositoryId,
		repositoryRootFolderId: context.getRepositoryRootFolderId(repositoryId),
		pullRequestNumber,
	})
	const download = await zipBlobFromResult(context, result)
	const snapshot = {
		zipFileId,
		blob: download.blob,
		files: await repositoryFilesFromZipBlob(download.blob),
	}
	cache.pullRequestZips.set(pullRequest.id, snapshot)
	storePullRequestFiles(context, repositoryId, pullRequest.id, snapshot.files)
	return snapshot
}

export async function syncDueGitHubMirrors({
	context,
	cache,
	state,
	onState,
}: {
	context: ClientZipWorkflowContext
	cache: ClientZipWorkflowCache
	state: AppState
	onState: (state: AppState) => void
}) {
	let currentState = state
	try {
		for (const repository of gitHubMirrorRepositoriesDueForSync(currentState)) {
			if (!repository.githubMirror) continue
			const repositoryZipFileId =
				currentState.repositoryZipFileIds[repository.id]
			if (!repositoryZipFileId) continue
			context.setProgress({
				phase: "preparing",
				current: 0,
				total: 1,
				message: `Refreshing ${repository.owner}/${repository.name} from GitHub`,
			})
			const snapshot = await fetchGitHubRepositorySnapshot(
				repository.githubMirror.htmlUrl,
				context.setProgress,
			)
			const repositoryFiles = prepareRepositoryUploadFiles(
				snapshot.files,
				currentState.settings,
				"repository",
			)
			const blob = await buildClientZipBlob({
				files: repositoryFiles,
				onProgress: context.setProgress,
			})
			const repositoryRootFolderId =
				context.getRepositoryRootFolderId(repository.id) ??
				repository.rootFolderId
			const { uploadTicket, zipFile } = await uploadPreparedArchiveToDrive(
				context,
				{
					kind: "github-mirror-sync",
					repositoryId: repository.id,
					repositoryRootFolderId,
					baseRepositoryZipFileId: repositoryZipFileId,
					zipBytes: blob.size,
					origin: context.getOrigin(),
				},
				blob,
			)
			currentState = await context.completeGitHubMirrorSyncUpload({
				repositoryId: repository.id,
				repositoryRootFolderId,
				repositoryZipFileId: zipFile.id,
				uploadTicket,
				files: clientUploadMetadata(repositoryFiles, { includeSidecars: true }),
				githubMirror: snapshot.mirror,
			})
			cache.repositoryZips.delete(repository.id)
			onState(currentState)
		}
	} finally {
		context.setProgress(null)
	}
}

async function loadRepositoryZipSnapshot(
	context: ClientZipWorkflowContext,
	cache: ClientZipWorkflowCache,
	repositoryId: string,
) {
	const state = requireState(context)
	const zipFileId = state.repositoryZipFileIds[repositoryId]
	const cached = cache.repositoryZips.get(repositoryId)
	if (cached && cached.zipFileId === zipFileId) return cached
	const result = await context.downloadRepositoryZip({
		repositoryId,
		repositoryRootFolderId: context.getRepositoryRootFolderId(repositoryId),
	})
	const download = await zipBlobFromResult(context, result)
	const snapshot = {
		zipFileId,
		blob: download.blob,
		files: await repositoryFilesFromZipBlob(download.blob),
	}
	cache.repositoryZips.set(repositoryId, snapshot)
	return snapshot
}

async function uploadPreparedArchiveToDrive(
	context: ClientZipWorkflowContext,
	data: BeginZipUploadData,
	blob: Blob,
) {
	let uploadTicket: string | null = null
	let uploadFinished = false
	try {
		assertDriveQuotaAllowsUpload(context.getState(), blob.size)
		context.setProgress({
			phase: "uploading",
			current: 1,
			total: 1,
			message: "Preparing Drive upload",
		})
		const upload = await context.beginZipUpload(data)
		uploadTicket = upload.uploadTicket
		const zipFile = await uploadBlobToGoogleDriveSession({
			uploadUrl: upload.uploadUrl,
			blob,
			onProgress: context.setProgress,
		})
		uploadFinished = true
		return { uploadTicket: upload.uploadTicket, zipFile }
	} catch (cause) {
		if (uploadTicket && !uploadFinished) {
			await context.cancelZipUpload(uploadTicket).catch(() => undefined)
		}
		throw cause
	}
}

function storePullRequestFiles(
	context: ClientZipWorkflowContext,
	repositoryId: string,
	pullRequestId: string,
	files: RepositoryFile[],
) {
	context.setState((current) => {
		if (!current) return current
		const pullRequests = current.pullRequests[repositoryId] ?? []
		return {
			...current,
			pullRequests: {
				...current.pullRequests,
				[repositoryId]: pullRequests.map((pullRequest) =>
					pullRequest.id === pullRequestId
						? { ...pullRequest, files }
						: pullRequest,
				),
			},
			loadedPullRequestFileIds: [
				...new Set([
					...(current.loadedPullRequestFileIds ?? []),
					pullRequestId,
				]),
			],
		}
	})
}

async function zipBlobFromResult(
	context: ClientZipWorkflowContext,
	result: ZipPayload,
) {
	const responsePromise = fetch(result.fetchUrl)
	scheduleZipDownloadCleanup(context, result.downloadTicket)
	try {
		const response = await responsePromise
		if (!response.ok) {
			throw new Error(`Drive ZIP download failed: ${response.status}`)
		}
		return {
			blob: await response.blob(),
			name: result.name,
		} satisfies DownloadFile
	} catch (cause) {
		throw new Error(
			"Drive API ZIP download failed. Check whether the owner Drive allows link downloads and GOOGLE_DRIVE_BROWSER_API_KEY is configured.",
			{ cause },
		)
	}
}

function scheduleZipDownloadCleanup(
	context: ClientZipWorkflowContext,
	downloadTicket: string,
) {
	globalThis.setTimeout(() => {
		void context.revokeZipDownload(downloadTicket).catch(() => undefined)
	}, downloadCleanupDelayMs(context.getState()))
}

function downloadCleanupDelayMs(state: AppState | null) {
	return state?.settings.downloadCleanupDelayMs ?? APP_DOWNLOAD.cleanupDelayMs
}

function findPullRequestByNumber(
	state: AppState,
	repositoryId: string,
	pullRequestNumber: number,
) {
	const pullRequest = state.pullRequests[repositoryId]?.find(
		(candidate) => candidate.number === pullRequestNumber,
	)
	if (!pullRequest) throw new Error("Pull request not found.")
	return pullRequest
}

function requireState(context: ClientZipWorkflowContext) {
	const state = context.getState()
	if (!state) throw new Error("Repository state is still loading.")
	return state
}

function gitHubMirrorRepositoriesDueForSync(state: AppState) {
	const intervalHours = state.settings.githubMirrorSyncIntervalHours
	if (intervalHours <= 0) return []
	const intervalMs = intervalHours * APP_TIMING.msPerHour
	const now = Date.now()
	return state.repositories.filter((repository) => {
		if (!repository.githubMirror) return false
		const lastSyncedAt = repository.githubMirror.lastSyncedAt
		if (!lastSyncedAt) return true
		const parsed = Date.parse(lastSyncedAt)
		return !Number.isFinite(parsed) || now - parsed >= intervalMs
	})
}
