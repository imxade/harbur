import { afterEach, describe, expect, it, vi } from "vitest"
import {
	createClientZipWorkflowCache,
	createPullRequestFromFolder,
	loadPullRequestZipSnapshot,
	mergePullRequestWithClientZip,
	uploadRepositoryFromFolder,
	type BeginZipUploadData,
	type ClientZipWorkflowContext,
} from "../../src/lib/client-zip-workflows"
import { APP_SCHEMA, APP_SLUG } from "../../src/lib/app-config"
import type { AppState } from "../../src/lib/drive-state"
import type { RepositoryFile, RepositoryManifest } from "../../src/lib/types"
import { createRepositoryManifest } from "../../src/lib/repositories"
import {
	createBootstrapConfig,
	createDefaultSettings,
} from "../../src/lib/settings"
import { buildClientZipBlob } from "../../src/lib/upload-client"
import { unzipBlob } from "../../src/lib/zip"

const now = "2026-05-05T00:00:00.000Z"

const baseFiles: RepositoryFile[] = [
	{ path: "README.md", content: "hello", size: 5 },
	{ path: "src/index.ts", content: "console.log(1)", size: 14 },
]

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

describe("client ZIP workflows", () => {
	it("creates repositories through a staged browser ZIP upload without sending ZIP bodies to completion", async () => {
		const state = appState()
		const uploads = stubDriveUpload()
		const harness = workflowHarness(state)

		await uploadRepositoryFromFolder({
			context: harness.context,
			files: [
				browserFile("demo/README.md", "hello"),
				browserFile("demo/src/index.ts", "console.log(1)"),
			],
			name: "demo",
			description: "Demo repository",
		})

		expect(uploads).toHaveLength(1)
		const beginData = harness.beginZipUpload.mock.calls[0]?.[0]
		expect(beginData).toMatchObject({
			kind: "repository",
			name: "demo",
			origin: "http://localhost:3000",
		})
		expect(beginData?.zipBytes).toBe(uploads[0]?.size)

		const completeData = harness.completeRepositoryUpload.mock.calls[0]?.[0]
		expect(completeData).toMatchObject({
			name: "demo",
			description: "Demo repository",
			repositoryZipFileId: "uploaded-zip-1",
			uploadTicket: "ticket:repository",
		})
		expect(Object.keys(completeData ?? {})).not.toContain("blob")
		expect(completeData?.files.map((file) => file.path)).toEqual([
			"README.md",
			"src/index.ts",
		])
		expect(
			completeData?.files.find((file) => file.path === "README.md")?.content,
		).toBe("hello")
	})

	it("creates pull requests from a client-computed diff and compact staged PR ZIP pinned to the base repository ZIP", async () => {
		const repository = testRepository()
		const state = appState({
			repositories: [repository],
			repositoryZipFileIds: { [repository.id]: "repo-zip-1" },
			pullRequests: { [repository.id]: [] },
		})
		const baseZip = await buildClientZipBlob({ files: baseFiles })
		const uploads = stubDriveUpload()
		const harness = workflowHarness(state, {
			[repositoryZipUrl(repository.id)]: baseZip,
		})

		await createPullRequestFromFolder({
			context: harness.context,
			cache: createClientZipWorkflowCache(),
			repositoryId: repository.id,
			title: "Change index",
			body: "Update code",
			files: [
				browserFile("demo/src/index.ts", "console.log(2)"),
				browserFile("demo/src/new.ts", "export {}"),
			],
		})

		expect(harness.downloadRepositoryZip).toHaveBeenCalledWith({
			repositoryId: repository.id,
			repositoryRootFolderId: repository.rootFolderId,
		})
		const beginData = harness.beginZipUpload.mock.calls[0]?.[0]
		expect(beginData).toMatchObject({
			kind: "pull-request",
			repositoryId: repository.id,
			repositoryRootFolderId: repository.rootFolderId,
			baseRepositoryZipFileId: "repo-zip-1",
			origin: "http://localhost:3000",
		})
		expect(beginData?.zipBytes).toBe(uploads[0]?.size)

		const compactZipEntries = await unzipBlob(uploads[0] ?? new Blob())
		expect(compactZipEntries.map((entry) => entry.path)).toEqual([
			"src/index.ts",
			"src/new.ts",
		])

		const completeData = harness.completePullRequestUpload.mock.calls[0]?.[0]
		expect(completeData).toMatchObject({
			repositoryId: repository.id,
			repositoryRootFolderId: repository.rootFolderId,
			title: "Change index",
			body: "Update code",
			uploadZipFileId: "uploaded-zip-1",
			uploadTicket: "ticket:pull-request",
		})
		expect(Object.keys(completeData ?? {})).not.toContain("blob")
		expect(completeData?.files.map((file) => file.path)).toEqual([
			"src/index.ts",
			"src/new.ts",
		])
		expect(completeData?.baseFiles.map((file) => file.path)).toEqual([
			"README.md",
			"src/index.ts",
		])
		expect(completeData?.diff.map((file) => file.status).sort()).toEqual([
			"added",
			"deleted",
			"modified",
		])
	})

	it("hydrates selected pull request files from the client cache on cache hits", async () => {
		const repository = testRepository()
		const pullRequest = {
			id: "pr-1",
			number: 1,
			authorEmail: "author@example.com",
			title: "Change index",
			body: "Update code",
			state: "open" as const,
			createdAt: now,
			updatedAt: now,
			files: [],
			baseFiles: [],
			diff: [{ path: "src/index.ts", status: "modified" as const }],
			comments: [],
		}
		const state = appState({
			repositories: [repository],
			repositoryZipFileIds: { [repository.id]: "repo-zip-1" },
			pullRequests: { [repository.id]: [pullRequest] },
			pullRequestZipFileIds: { [pullRequest.id]: "pr-zip-1" },
			loadedPullRequestFileIds: [],
		})
		const cachedFiles = [
			{ path: "src/index.ts", content: "console.log(2)", size: 14 },
		]
		const cache = createClientZipWorkflowCache()
		cache.pullRequestZips.set(pullRequest.id, {
			zipFileId: "pr-zip-1",
			blob: new Blob(["cached"]),
			files: cachedFiles,
		})
		const harness = workflowHarness(state)

		const snapshot = await loadPullRequestZipSnapshot(
			harness.context,
			cache,
			repository.id,
			pullRequest.number,
		)

		expect(snapshot.files).toEqual(cachedFiles)
		expect(harness.downloadPullRequestZip).not.toHaveBeenCalled()
		const nextState = harness.context.getState()
		expect(nextState?.loadedPullRequestFileIds).toContain(pullRequest.id)
		expect(nextState?.pullRequests[repository.id]?.[0]?.files).toEqual(
			cachedFiles,
		)
	})

	it("merges pull requests by building the replacement repository ZIP in the browser and pinning it to the base ZIP", async () => {
		const repository = testRepository()
		const pullRequest = {
			id: "pr-1",
			number: 1,
			authorEmail: "author@example.com",
			title: "Change index",
			body: "Update code",
			state: "open" as const,
			createdAt: now,
			updatedAt: now,
			files: [],
			baseFiles: [],
			diff: [{ path: "src/index.ts", status: "modified" as const }],
			comments: [],
		}
		const state = appState({
			repositories: [repository],
			repositoryZipFileIds: { [repository.id]: "repo-zip-1" },
			pullRequests: { [repository.id]: [pullRequest] },
			pullRequestZipFileIds: { [pullRequest.id]: "pr-zip-1" },
		})
		const repoZip = await buildClientZipBlob({ files: baseFiles })
		const prZip = await buildClientZipBlob({
			files: [
				{
					path: "src/index.ts",
					content: "console.log(2)",
					size: 14,
				},
			],
		})
		const uploads = stubDriveUpload()
		const harness = workflowHarness(state, {
			[repositoryZipUrl(repository.id)]: repoZip,
			[pullRequestZipUrl(repository.id, pullRequest.number)]: prZip,
		})

		await mergePullRequestWithClientZip({
			context: harness.context,
			cache: createClientZipWorkflowCache(),
			repositoryId: repository.id,
			pullRequestNumber: pullRequest.number,
		})

		expect(harness.downloadRepositoryZip).toHaveBeenCalledOnce()
		expect(harness.downloadPullRequestZip).toHaveBeenCalledWith({
			repositoryId: repository.id,
			repositoryRootFolderId: repository.rootFolderId,
			pullRequestNumber: pullRequest.number,
		})
		const beginData = harness.beginZipUpload.mock.calls[0]?.[0]
		expect(beginData).toMatchObject({
			kind: "pull-merge",
			repositoryId: repository.id,
			repositoryRootFolderId: repository.rootFolderId,
			pullRequestNumber: pullRequest.number,
			baseRepositoryZipFileId: "repo-zip-1",
			origin: "http://localhost:3000",
		})
		expect(beginData?.zipBytes).toBe(uploads[0]?.size)

		const mergedZipEntries = await unzipBlob(uploads[0] ?? new Blob())
		expect(mergedZipEntries.map((entry) => entry.path)).toEqual([
			"README.md",
			"src/index.ts",
		])
		expect(new TextDecoder().decode(mergedZipEntries[1]?.bytes)).toBe(
			"console.log(2)",
		)

		const completeData =
			harness.completePullRequestMergeUpload.mock.calls[0]?.[0]
		expect(completeData).toMatchObject({
			repositoryId: repository.id,
			repositoryRootFolderId: repository.rootFolderId,
			pullRequestNumber: pullRequest.number,
			repositoryZipFileId: "uploaded-zip-1",
			uploadTicket: "ticket:pull-merge",
		})
		expect(Object.keys(completeData ?? {})).not.toContain("blob")
		expect(completeData?.files.map((file) => file.path)).toEqual([
			"README.md",
			"src/index.ts",
		])
	})

	it("rejects staged ZIP uploads before creating a Drive session when reported owner Drive quota is too low", async () => {
		const state = appState({
			driveStorageQuota: { limit: "100", usage: "100" },
		})
		const harness = workflowHarness(state)

		await expect(
			uploadRepositoryFromFolder({
				context: harness.context,
				files: [browserFile("demo/README.md", "hello")],
				name: "demo",
			}),
		).rejects.toThrow("Owner Drive has")

		expect(harness.beginZipUpload).not.toHaveBeenCalled()
		expect(harness.completeRepositoryUpload).not.toHaveBeenCalled()
	})
})

function appState(overrides: Partial<AppState> = {}): AppState {
	const settings = createDefaultSettings("test@example.com", now)
	return {
		schema: APP_SCHEMA.state,
		config: createBootstrapConfig(),
		settings,
		rootFolder: { id: "root-folder", name: "Harbur" },
		driveStorageQuota: { limit: "1000000000", usage: "1" },
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
		users: {
			"test@example.com": {
				email: "test@example.com",
				ownerName: APP_SLUG,
				createdAt: now,
				updatedAt: now,
			},
		},
		notifications: {},
		activity: [],
		backupCredentials: {},
		...overrides,
	}
}

function testRepository(): RepositoryManifest {
	return createRepositoryManifest({
		owner: APP_SLUG,
		name: "demo",
		rootFolderId: "repo-root-folder",
		files: baseFiles,
		now,
	})
}

function browserFile(path: string, content: string) {
	const file = new File([content], path)
	Object.defineProperty(file, "webkitRelativePath", { value: path })
	return file
}

function repositoryZipUrl(repositoryId: string) {
	return `https://download.test/${encodeURIComponent(repositoryId)}/repository.zip`
}

function pullRequestZipUrl(repositoryId: string, pullRequestNumber: number) {
	return `https://download.test/${encodeURIComponent(repositoryId)}/pull-${pullRequestNumber}.zip`
}

function workflowHarness(
	initialState: AppState,
	downloads: Record<string, Blob> = {},
) {
	let currentState = initialState
	const beginZipUpload = vi.fn<ClientZipWorkflowContext["beginZipUpload"]>(
		async (data: BeginZipUploadData) => ({
			uploadUrl: "https://upload.test/session",
			uploadTicket: `ticket:${data.kind}`,
			uploadFolderId: "upload-folder",
			repositoryRootFolderId:
				data.kind === "repository" ? "repo-root-folder" : undefined,
		}),
	)
	const cancelZipUpload = vi.fn<ClientZipWorkflowContext["cancelZipUpload"]>(
		async () => undefined,
	)
	const revokeZipDownload = vi.fn<
		ClientZipWorkflowContext["revokeZipDownload"]
	>(async () => undefined)
	const completeRepositoryUpload = vi.fn<
		ClientZipWorkflowContext["completeRepositoryUpload"]
	>(async () => currentState)
	const completePullRequestUpload = vi.fn<
		ClientZipWorkflowContext["completePullRequestUpload"]
	>(async () => currentState)
	const completePullRequestMergeUpload = vi.fn<
		ClientZipWorkflowContext["completePullRequestMergeUpload"]
	>(async () => currentState)
	const completeGitHubMirrorSyncUpload = vi.fn<
		ClientZipWorkflowContext["completeGitHubMirrorSyncUpload"]
	>(async () => currentState)
	const downloadRepositoryZip = vi.fn<
		ClientZipWorkflowContext["downloadRepositoryZip"]
	>(
		async ({
			repositoryId,
		}: {
			repositoryId: string
			repositoryRootFolderId?: string
		}) => ({
			name: `${repositoryId}.zip`,
			fetchUrl: repositoryZipUrl(repositoryId),
			downloadTicket: `download:${repositoryId}:repository`,
		}),
	)
	const downloadPullRequestZip = vi.fn<
		ClientZipWorkflowContext["downloadPullRequestZip"]
	>(
		async ({
			repositoryId,
			pullRequestNumber,
		}: {
			repositoryId: string
			repositoryRootFolderId?: string
			pullRequestNumber: number
		}) => ({
			name: `${repositoryId}-pr-${pullRequestNumber}.zip`,
			fetchUrl: pullRequestZipUrl(repositoryId, pullRequestNumber),
			downloadTicket: `download:${repositoryId}:pull-${pullRequestNumber}`,
		}),
	)
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = typeof input === "string" ? input : String(input)
		const blob = downloads[url]
		return blob
			? new Response(blob, { status: 200 })
			: new Response("missing test ZIP", { status: 404 })
	})

	const context: ClientZipWorkflowContext = {
		getState: () => currentState,
		setState: (updater) => {
			currentState = updater(currentState) ?? currentState
		},
		setProgress: () => undefined,
		getRepositoryRootFolderId: (repositoryId) =>
			currentState.repositories.find(
				(repository) => repository.id === repositoryId,
			)?.rootFolderId,
		getOrigin: () => "http://localhost:3000",
		beginZipUpload,
		cancelZipUpload,
		revokeZipDownload,
		completeRepositoryUpload,
		completePullRequestUpload,
		completePullRequestMergeUpload,
		completeGitHubMirrorSyncUpload,
		downloadRepositoryZip,
		downloadPullRequestZip,
	}

	return {
		context,
		beginZipUpload,
		cancelZipUpload,
		revokeZipDownload,
		completeRepositoryUpload,
		completePullRequestUpload,
		completePullRequestMergeUpload,
		completeGitHubMirrorSyncUpload,
		downloadRepositoryZip,
		downloadPullRequestZip,
	}
}

function stubDriveUpload() {
	const uploads: Blob[] = []
	class FakeXMLHttpRequest {
		upload = {} as XMLHttpRequestUpload
		status = 200
		responseText = ""
		onload: (() => void) | null = null
		onerror: (() => void) | null = null

		open() {
			// XMLHttpRequest API stub.
		}

		setRequestHeader() {
			// XMLHttpRequest API stub.
		}

		send(blob: Blob) {
			uploads.push(blob)
			this.responseText = JSON.stringify({
				id: `uploaded-zip-${uploads.length}`,
				name: "harbur.upload.zip",
			})
			const uploadTarget = this.upload as XMLHttpRequestUpload & {
				onprogress?: (event: ProgressEvent) => void
			}
			uploadTarget.onprogress?.({
				lengthComputable: true,
				loaded: blob.size,
				total: blob.size,
			} as ProgressEvent)
			this.onload?.()
		}
	}
	vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest)
	return uploads
}
