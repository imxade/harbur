import "@tanstack/react-start/client-only"
import { APP_DOWNLOAD, APP_TIMING } from "./app-config"
import type {
	ClientPullRequestDiffSnapshot,
	ClientZipWorkflowCache,
} from "./client-zip-cache"
import type {
	BeginZipUploadData,
	ClientZipWorkflowContext,
	ZipPayload,
} from "./client-zip-contract"
import type { DownloadFile } from "./download-client"
import type { AppState } from "./drive-state"
import { assertDriveQuotaAllowsUpload } from "./drive-quota"
import { fetchGitHubRepositorySnapshot } from "./github"
import { diffRepositoryFiles } from "./pulls"
import { prepareRepositoryUploadFiles } from "./repositories/uploads"
import {
	buildClientZipBlob,
	clientUploadMetadata,
	prepareClientUploadArchive,
	prepareClientUploadSnapshot,
	repositoryFilesFromZipBlob,
	uploadBlobToGoogleDriveSession,
} from "./upload-client"

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
	if (!diff.length) throw new Error("Pull request has no changes.")
	if (!baseSnapshot.zipFileId) throw new Error("Repository ZIP is missing.")
	const blob = await buildClientZipBlob({
		files: uploadSnapshot.files,
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
	const nextState = await context.completePullRequestUpload({
		repositoryId,
		repositoryRootFolderId,
		title,
		body,
		uploadZipFileId: zipFile.id,
		uploadTicket,
	})
	const createdPullRequest = nextState.pullRequests[repositoryId]?.find(
		(pullRequest) =>
			nextState.pullRequestZipFileIds[pullRequest.id] === zipFile.id,
	)
	if (createdPullRequest?.baseRepositoryZipFileId) {
		const proposalSnapshot = {
			zipFileId: zipFile.id,
			files: uploadSnapshot.files,
		}
		cache.pullRequestZips.set(createdPullRequest.id, proposalSnapshot)
		cache.pullRequestBaseZips.set(createdPullRequest.id, baseSnapshot)
		cache.pullRequestDiffs.set(createdPullRequest.id, {
			baseZipFileId: createdPullRequest.baseRepositoryZipFileId,
			proposalZipFileId: zipFile.id,
			diff,
			baseFiles: baseSnapshot.files,
			proposalFiles: proposalSnapshot.files,
		})
		trimPullRequestCaches(cache)
	}
	return nextState
}

export async function mergePullRequestWithProposal({
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
	const pullRequest = findPullRequestByNumber(
		state,
		repositoryId,
		pullRequestNumber,
	)
	if (
		!pullRequest.baseRepositoryZipFileId ||
		state.repositoryZipFileIds[repositoryId] !==
			pullRequest.baseRepositoryZipFileId
	) {
		throw new Error(
			"Repository changed after this pull request was created. Recreate the pull request from the current repository.",
		)
	}
	const pullSnapshot = await loadPullRequestZipSnapshot(
		context,
		cache,
		repositoryId,
		pullRequestNumber,
	)
	const repositoryRootFolderId = context.getRepositoryRootFolderId(repositoryId)
	const nextState = await context.mergePullRequest({
		repositoryId,
		repositoryRootFolderId,
		pullRequestNumber,
	})
	const zipFileId = nextState.repositoryZipFileIds[repositoryId]
	cache.repositoryZips.set(repositoryId, {
		zipFileId,
		files: pullSnapshot.files,
	})
	trimCache(cache.repositoryZips)
	return {
		...nextState,
		repositoryFiles: {
			...nextState.repositoryFiles,
			[repositoryId]: pullSnapshot.files,
		},
		loadedRepositoryFileIds: [
			...new Set([...(nextState.loadedRepositoryFileIds ?? []), repositoryId]),
		],
	}
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
	return {
		blob: await buildClientZipBlob({ files: pullSnapshot.files }),
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
		return cached
	}
	const result = await context.downloadPullRequestZip({
		repositoryId,
		repositoryRootFolderId: context.getRepositoryRootFolderId(repositoryId),
		pullRequestNumber,
	})
	const download = await zipBlobFromResult(context, result)
	await assertBlobSha256(download.blob, pullRequest.proposalZipSha256)
	const snapshot = {
		zipFileId,
		files: await repositoryFilesFromZipBlob(
			download.blob,
			state.settings,
			"pull-request",
		),
	}
	cache.pullRequestZips.set(pullRequest.id, snapshot)
	trimPullRequestCaches(cache)
	return snapshot
}

export async function loadPullRequestDiffSnapshot(
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
	const baseZipFileId = pullRequest.baseRepositoryZipFileId
	const proposalZipFileId = state.pullRequestZipFileIds[pullRequest.id]
	if (!baseZipFileId || !proposalZipFileId) {
		throw new Error("Legacy pull request artifacts are unavailable.")
	}
	const cached = cache.pullRequestDiffs.get(pullRequest.id)
	if (
		cached?.baseZipFileId === baseZipFileId &&
		cached.proposalZipFileId === proposalZipFileId
	) {
		return cached
	}
	let baseSnapshot = cache.pullRequestBaseZips.get(pullRequest.id)
	if (!baseSnapshot || baseSnapshot.zipFileId !== baseZipFileId) {
		const currentRepositorySnapshot = cache.repositoryZips.get(repositoryId)
		if (currentRepositorySnapshot?.zipFileId === baseZipFileId) {
			baseSnapshot = currentRepositorySnapshot
		}
	}
	if (!baseSnapshot || baseSnapshot.zipFileId !== baseZipFileId) {
		const baseDownload = await zipBlobFromResult(
			context,
			await context.downloadPullRequestBaseZip({
				repositoryId,
				repositoryRootFolderId: context.getRepositoryRootFolderId(repositoryId),
				pullRequestNumber,
			}),
		)
		const expectedBaseSha256 = state.repositorySnapshots[repositoryId]?.find(
			(snapshot) => snapshot.driveFileId === baseZipFileId,
		)?.sha256
		await assertBlobSha256(baseDownload.blob, expectedBaseSha256)
		baseSnapshot = {
			zipFileId: baseZipFileId,
			files: await repositoryFilesFromZipBlob(
				baseDownload.blob,
				state.settings,
				"repository",
			),
		}
		cache.pullRequestBaseZips.set(pullRequest.id, baseSnapshot)
		trimPullRequestCaches(cache)
	}
	const proposalSnapshot = await loadPullRequestZipSnapshot(
		context,
		cache,
		repositoryId,
		pullRequestNumber,
		state,
	)
	const snapshot: ClientPullRequestDiffSnapshot = {
		baseZipFileId,
		proposalZipFileId,
		diff: diffRepositoryFiles(
			baseSnapshot.files,
			proposalSnapshot.files,
		).filter((fileDiff) => fileDiff.status !== "unchanged"),
		baseFiles: baseSnapshot.files,
		proposalFiles: proposalSnapshot.files,
	}
	cache.pullRequestDiffs.set(pullRequest.id, snapshot)
	trimPullRequestCaches(cache)
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

export async function loadRepositoryZipSnapshot(
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
		files: await repositoryFilesFromZipBlob(
			download.blob,
			state.settings,
			"repository",
		),
	}
	cache.repositoryZips.set(repositoryId, snapshot)
	trimCache(cache.repositoryZips)
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

function trimCache<T>(cache: Map<string, T>, maxEntries = 4) {
	while (cache.size > maxEntries) {
		const oldest = cache.keys().next().value
		if (!oldest) return
		cache.delete(oldest)
	}
}

function trimPullRequestCaches(cache: ClientZipWorkflowCache, maxEntries = 4) {
	const keys = [...cache.pullRequestDiffs.keys()]
	while (keys.length > maxEntries) {
		const oldest = keys.shift()
		if (!oldest) return
		cache.pullRequestDiffs.delete(oldest)
		cache.pullRequestBaseZips.delete(oldest)
		cache.pullRequestZips.delete(oldest)
	}
	trimCache(cache.pullRequestBaseZips, maxEntries)
	trimCache(cache.pullRequestZips, maxEntries)
}

async function assertBlobSha256(blob: Blob, expected: string | undefined) {
	if (!expected) return
	const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())
	const actual = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("")
	if (actual !== expected)
		throw new Error("Downloaded ZIP checksum did not match.")
}

async function zipBlobFromResult(
	context: ClientZipWorkflowContext,
	result: ZipPayload,
) {
	const responsePromise = fetch(result.fetchUrl, {
		credentials: "omit",
		referrerPolicy: "strict-origin",
	})
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
