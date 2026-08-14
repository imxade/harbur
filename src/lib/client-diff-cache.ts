import type { FileDiff } from "./pulls"

export type ClientDiffContent = {
	content: string | Uint8Array
	encoding?: "utf8" | "base64"
}

export type ClientFileDiff = FileDiff & {
	before?: ClientDiffContent
	after?: ClientDiffContent
}

export type ClientPullRequestDiffSnapshot = {
	baseZipFileId: string
	proposalZipFileId: string
	diff: ClientFileDiff[]
}

export type ClientPullRequestDiffCache = {
	pullRequestDiffs: Map<string, ClientPullRequestDiffSnapshot>
}

export function createClientPullRequestDiffCache(): ClientPullRequestDiffCache {
	return { pullRequestDiffs: new Map() }
}

export function clearClientPullRequestDiffCache(
	cache: ClientPullRequestDiffCache,
) {
	cache.pullRequestDiffs.clear()
}
