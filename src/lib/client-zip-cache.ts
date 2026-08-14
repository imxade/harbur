import type { FileDiff } from "./pulls"
import type { RepositoryFile } from "./types"

export type ZipSnapshot = {
	zipFileId?: string
	files: RepositoryFile[]
}

export type ClientPullRequestDiffSnapshot = {
	baseZipFileId: string
	proposalZipFileId: string
	diff: FileDiff[]
	baseFiles: RepositoryFile[]
	proposalFiles: RepositoryFile[]
}

export type ClientZipWorkflowCache = {
	repositoryZips: Map<string, ZipSnapshot>
	pullRequestZips: Map<string, ZipSnapshot>
	pullRequestBaseZips: Map<string, ZipSnapshot>
	pullRequestDiffs: Map<string, ClientPullRequestDiffSnapshot>
}

export function createClientZipWorkflowCache(): ClientZipWorkflowCache {
	return {
		repositoryZips: new Map(),
		pullRequestZips: new Map(),
		pullRequestBaseZips: new Map(),
		pullRequestDiffs: new Map(),
	}
}

export function clearClientZipWorkflowCache(cache: ClientZipWorkflowCache) {
	cache.repositoryZips.clear()
	cache.pullRequestZips.clear()
	cache.pullRequestBaseZips.clear()
	cache.pullRequestDiffs.clear()
}
