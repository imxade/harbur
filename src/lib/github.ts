import { repositoryFileFromBytes } from "./repositories"
import type { GitHubMirror, RepositoryFile } from "./types"

type GitHubRepoApiResponse = {
	name?: string
	owner?: { login?: string }
	default_branch?: string
	html_url?: string
}

type GitHubBranchApiResponse = {
	commit?: {
		sha?: string
		commit?: {
			tree?: { sha?: string }
		}
	}
}

type GitHubTreeApiResponse = {
	truncated?: boolean
	tree?: Array<{
		path?: string
		sha?: string
		type?: string
		size?: number
	}>
}

type GitHubBlobApiResponse = {
	content?: string
	encoding?: string
}

type GitHubSnapshotProgress = (progress: {
	phase: "preparing"
	current: number
	total: number
	message: string
}) => void

const GITHUB_API_ACCEPT = "application/vnd.github+json"
const GITHUB_BLOB_FETCH_CONCURRENCY = 8
const GITHUB_REPO_URL_PATTERN =
	/^https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\/.*)?$/i

function parseGitHubRepositoryUrl(value: string) {
	const match = value
		.trim()
		.replace(/\.git$/i, "")
		.match(GITHUB_REPO_URL_PATTERN)
	if (!match) {
		throw new Error("Enter a public GitHub repository URL.")
	}
	return {
		owner: match[1],
		repo: match[2],
	}
}

export async function fetchGitHubRepositorySnapshot(
	githubUrl: string,
	onProgress?: GitHubSnapshotProgress,
): Promise<{
	files: RepositoryFile[]
	mirror: GitHubMirror
	description?: string
}> {
	const parsed = parseGitHubRepositoryUrl(githubUrl)
	const repoApiUrl = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`
	const repoData = await fetchGitHubJson<GitHubRepoApiResponse>(
		repoApiUrl,
		"GitHub repository lookup",
	)
	const owner = repoData.owner?.login ?? parsed.owner
	const repo = repoData.name ?? parsed.repo
	const branch = repoData.default_branch ?? "main"
	const htmlUrl = repoData.html_url ?? `https://github.com/${owner}/${repo}`
	const zipUrl = `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zip/refs/heads/${encodeURIComponent(branch)}`
	const branchData = await fetchGitHubJson<GitHubBranchApiResponse>(
		`${repoApiUrl}/branches/${encodeURIComponent(branch)}`,
		"GitHub branch lookup",
	)
	const commitSha = branchData.commit?.sha
	const treeSha = branchData.commit?.commit?.tree?.sha
	if (!commitSha || !treeSha) {
		throw new Error("GitHub branch response did not include a commit tree.")
	}
	const treeData = await fetchGitHubJson<GitHubTreeApiResponse>(
		`${repoApiUrl}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
		"GitHub tree lookup",
	)
	if (treeData.truncated) {
		throw new Error(
			"GitHub repository tree is too large for browser mirror import.",
		)
	}
	const blobs = (treeData.tree ?? [])
		.filter(
			(entry): entry is { path: string; sha: string; type: string } =>
				entry.type === "blob" && Boolean(entry.path && entry.sha),
		)
		.sort((left, right) => left.path.localeCompare(right.path))
	const files = await mapWithConcurrency(
		blobs,
		GITHUB_BLOB_FETCH_CONCURRENCY,
		async (entry, index) => {
			onProgress?.({
				phase: "preparing",
				current: index + 1,
				total: blobs.length,
				message: `Fetching GitHub file ${index + 1}/${blobs.length}`,
			})
			return repositoryFileFromBytes({
				path: entry.path,
				bytes: await fetchGitHubFileBytes({
					repoApiUrl,
					owner,
					repo,
					commitSha,
					path: entry.path,
					sha: entry.sha,
				}),
			})
		},
	)
	return {
		files,
		mirror: {
			type: "github",
			owner,
			repo,
			branch,
			htmlUrl,
			zipUrl,
			lastSyncedAt: new Date().toISOString(),
			lastSyncStatus: "ok",
		},
	}
}

async function fetchGitHubJson<T>(url: string, label: string) {
	const response = await fetch(url, {
		headers: { Accept: GITHUB_API_ACCEPT },
	})
	if (!response.ok) {
		const rateRemaining = response.headers.get("x-ratelimit-remaining")
		if (response.status === 403 && rateRemaining === "0") {
			throw new Error(`${label} failed: GitHub API rate limit exceeded.`)
		}
		throw new Error(`${label} failed: ${response.status}`)
	}
	return (await response.json()) as T
}

async function fetchGitHubFileBytes({
	repoApiUrl,
	owner,
	repo,
	commitSha,
	path,
	sha,
}: {
	repoApiUrl: string
	owner: string
	repo: string
	commitSha: string
	path: string
	sha: string
}) {
	const rawUrl = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(commitSha)}/${path
		.split("/")
		.map(encodeURIComponent)
		.join("/")}`
	try {
		const rawResponse = await fetch(rawUrl)
		if (rawResponse.ok) {
			return new Uint8Array(await rawResponse.arrayBuffer())
		}
	} catch {
		// Fall back to the Git blob API when raw.githubusercontent.com is blocked.
	}
	const blob = await fetchGitHubJson<GitHubBlobApiResponse>(
		`${repoApiUrl}/git/blobs/${encodeURIComponent(sha)}`,
		`GitHub blob fetch for ${path}`,
	)
	if (blob.encoding !== "base64" || !blob.content) {
		throw new Error(`GitHub blob response for ${path} is not base64.`)
	}
	return base64ToBytes(blob.content)
}

function base64ToBytes(value: string) {
	const binary = atob(value.replace(/\s/g, ""))
	const bytes = new Uint8Array(binary.length)
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index)
	}
	return bytes
}

async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	mapper: (item: T, index: number) => Promise<R>,
) {
	const results = new Array<R>(items.length)
	let nextIndex = 0
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (nextIndex < items.length) {
				const index = nextIndex
				nextIndex += 1
				results[index] = await mapper(items[index] as T, index)
			}
		}),
	)
	return results
}
