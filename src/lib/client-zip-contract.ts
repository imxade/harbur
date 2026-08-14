import type { AppState, UploadProgress } from "./drive-state"
import type { GitHubMirror } from "./types"
import type { ClientUploadFileMetadata } from "./upload-client"

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

export type ZipPayload = {
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
	}) => Promise<AppState>
	mergePullRequest: (data: {
		repositoryId: string
		repositoryRootFolderId?: string
		pullRequestNumber: number
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
	downloadPullRequestBaseZip: (data: {
		repositoryId: string
		repositoryRootFolderId?: string
		pullRequestNumber: number
	}) => Promise<ZipPayload>
}
