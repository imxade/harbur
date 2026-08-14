import "@tanstack/react-start/client-only"
import { APP_DOWNLOAD, APP_TIMING } from "./app-config"
import type {
	ClientPullRequestDiffSnapshot,
	ClientPullRequestDiffCache,
} from "./client-diff-cache"
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
import type { RepositoryFile } from "./types"
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
	cache: ClientPullRequestDiffCache
	repositoryId: string
	title: string
	body: string
	files: File[]
}) {
	const state = requireState(context)
	const baseSnapshot = await loadRepositoryZipSnapshot(context, repositoryId)
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
		cache.pullRequestDiffs.set(
			createdPullRequest.id,
			pullRequestDiffSnapshot({
				baseZipFileId: createdPullRequest.baseRepositoryZipFileId,
				proposalZipFileId: zipFile.id,
				baseFiles: baseSnapshot.files,
				proposalFiles: uploadSnapshot.files,
				diff,
			}),
		)
		trimPullRequestDiffCache(cache)
	}
	return nextState
}

export async function mergePullRequestWithProposal({
	context,
	repositoryId,
	pullRequestNumber,
}: {
	context: ClientZipWorkflowContext
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
	const repositoryRootFolderId = context.getRepositoryRootFolderId(repositoryId)
	const nextState = await context.mergePullRequest({
		repositoryId,
		repositoryRootFolderId,
		pullRequestNumber,
	})
	const repositorySnapshot = await loadRepositoryZipSnapshot(
		context,
		repositoryId,
		nextState,
	)
	return {
		...nextState,
		repositoryFiles: {
			...nextState.repositoryFiles,
			[repositoryId]: repositorySnapshot.files,
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

export async function downloadPullRequestArchiveZipFile({
	context,
	repositoryId,
	pullRequestNumber,
}: {
	context: ClientZipWorkflowContext
	repositoryId: string
	pullRequestNumber: number
}) {
	const state = requireState(context)
	const pullRequest = findPullRequestByNumber(
		state,
		repositoryId,
		pullRequestNumber,
	)
	if (pullRequest.state === "closed") {
		throw new Error("Closed pull request archives are unavailable.")
	}
	const result =
		pullRequest.state === "merged"
			? await context.downloadPullRequestBaseZip({
					repositoryId,
					repositoryRootFolderId:
						context.getRepositoryRootFolderId(repositoryId),
					pullRequestNumber,
				})
			: await context.downloadPullRequestZip({
					repositoryId,
					repositoryRootFolderId:
						context.getRepositoryRootFolderId(repositoryId),
					pullRequestNumber,
				})
	return await zipBlobFromResult(context, result)
}

export async function loadPullRequestZipSnapshot(
	context: ClientZipWorkflowContext,
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
	return snapshot
}

export async function loadPullRequestDiffSnapshot(
	context: ClientZipWorkflowContext,
	cache: ClientPullRequestDiffCache,
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
	const baseZipFileId = state.repositoryZipFileIds[repositoryId]
	const proposalZipFileId = state.pullRequestZipFileIds[pullRequest.id]
	if (!baseZipFileId || !proposalZipFileId) {
		throw new Error("Pull request artifacts are unavailable.")
	}
	const cached = cache.pullRequestDiffs.get(pullRequest.id)
	if (
		cached?.baseZipFileId === baseZipFileId &&
		cached.proposalZipFileId === proposalZipFileId
	) {
		return cached
	}
	const baseSnapshot = await loadRepositoryZipSnapshot(
		context,
		repositoryId,
		state,
	)
	const proposalSnapshot = await loadPullRequestZipSnapshot(
		context,
		repositoryId,
		pullRequestNumber,
		state,
	)
	const snapshot = pullRequestDiffSnapshot({
		baseZipFileId,
		proposalZipFileId,
		diff: diffRepositoryFiles(
			baseSnapshot.files,
			proposalSnapshot.files,
		).filter((fileDiff) => fileDiff.status !== "unchanged"),
		baseFiles: baseSnapshot.files,
		proposalFiles: proposalSnapshot.files,
	})
	cache.pullRequestDiffs.set(pullRequest.id, snapshot)
	trimPullRequestDiffCache(cache)
	return snapshot
}

export async function syncDueGitHubMirrors({
	context,
	state,
	onState,
}: {
	context: ClientZipWorkflowContext
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
			onState(currentState)
		}
	} finally {
		context.setProgress(null)
	}
}

export async function loadRepositoryZipSnapshot(
	context: ClientZipWorkflowContext,
	repositoryId: string,
	state: AppState = requireState(context),
) {
	const zipFileId = state.repositoryZipFileIds[repositoryId]
	const result = await context.downloadRepositoryZip({
		repositoryId,
		repositoryRootFolderId: context.getRepositoryRootFolderId(repositoryId),
	})
	const download = await zipBlobFromResult(context, result)
	const expectedSha256 = state.repositorySnapshots[repositoryId]?.find(
		(snapshot) => snapshot.driveFileId === zipFileId,
	)?.sha256
	await assertBlobSha256(download.blob, expectedSha256)
	const snapshot = {
		zipFileId,
		files: await repositoryFilesFromZipBlob(
			download.blob,
			state.settings,
			"repository",
		),
	}
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

function trimPullRequestDiffCache(
	cache: ClientPullRequestDiffCache,
	maxEntries = 4,
) {
	while (cache.pullRequestDiffs.size > maxEntries) {
		const oldest = cache.pullRequestDiffs.keys().next().value
		if (!oldest) return
		cache.pullRequestDiffs.delete(oldest)
	}
}

function pullRequestDiffSnapshot({
	baseZipFileId,
	proposalZipFileId,
	diff,
	baseFiles,
	proposalFiles,
}: {
	baseZipFileId: string
	proposalZipFileId: string
	diff: ClientPullRequestDiffSnapshot["diff"]
	baseFiles: RepositoryFile[]
	proposalFiles: RepositoryFile[]
}): ClientPullRequestDiffSnapshot {
	const base = new Map(baseFiles.map((file) => [file.path, file]))
	const proposal = new Map(proposalFiles.map((file) => [file.path, file]))
	return {
		baseZipFileId,
		proposalZipFileId,
		diff: diff.map((fileDiff) => ({
			...fileDiff,
			before: diffContent(base.get(fileDiff.path)),
			after: diffContent(proposal.get(fileDiff.path)),
		})),
	}
}

function diffContent(file: RepositoryFile | undefined) {
	return file
		? {
				content: file.content,
				encoding: file.encoding,
			}
		: undefined
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
