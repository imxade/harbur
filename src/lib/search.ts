import { APP_NAME } from "./app-config"
import type { RepositoryManifest } from "./types"

const GITHUB_REPOSITORY_URL_PATTERN =
	/^https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\/.*)?$/i

export type RepositorySummary = {
	id: string
	name: string
	owner: string
	repositoryName: string
	description: string
	category: string
	visibility: "public" | "private"
	href: string
	updatedAt: string
	githubUrl?: string
	searchText: string
}

export function inferRepositoryNameFromGitHubUrl(value: string) {
	const match = value
		.trim()
		.replace(/\.git$/i, "")
		.match(GITHUB_REPOSITORY_URL_PATTERN)
	if (!match) throw new Error("Enter a public GitHub repository URL.")
	return match[2]
}

export function toRepositorySummary(
	repository: RepositoryManifest,
): RepositorySummary {
	return {
		id: repository.id,
		name: `${repository.owner}/${repository.name}`,
		owner: repository.owner,
		repositoryName: repository.name,
		description:
			repository.description ?? `Drive-backed ${APP_NAME} repository.`,
		category: "repositories",
		visibility: repository.visibility,
		href: `/repo/${repository.owner}/${repository.name}`,
		updatedAt: repository.updatedAt,
		githubUrl: repository.githubMirror?.htmlUrl,
		searchText: [
			repository.owner,
			repository.name,
			repository.description,
			repository.githubMirror?.owner,
			repository.githubMirror?.repo,
			repository.githubMirror?.htmlUrl,
			...repository.labels.flatMap((label) => [
				label.name,
				label.description ?? "",
			]),
		]
			.filter(Boolean)
			.join(" "),
	}
}

export type OwnerRepositoryGroup = {
	owner: string
	repositories: RepositorySummary[]
	updatedAt: number
}

export function groupRepositoriesByOwner(
	repositories: RepositorySummary[],
): OwnerRepositoryGroup[] {
	return Array.from(
		repositories
			.reduce((groups, repository) => {
				const ownerRepositories = groups.get(repository.owner) ?? []
				ownerRepositories.push(repository)
				groups.set(repository.owner, ownerRepositories)
				return groups
			}, new Map<string, RepositorySummary[]>())
			.entries(),
	)
		.map(([owner, ownerRepositories]) => ({
			owner,
			repositories: ownerRepositories.sort((left, right) =>
				left.repositoryName.localeCompare(right.repositoryName),
			),
			updatedAt: Math.max(
				...ownerRepositories.map((repository) =>
					new Date(repository.updatedAt).getTime(),
				),
			),
		}))
		.sort((left, right) => left.owner.localeCompare(right.owner))
}

export function rankRepositoriesByQuery(
	repositories: RepositorySummary[],
	query: string,
) {
	const trimmed = normalizeSearchValue(query)
	if (!trimmed) return null
	return repositories
		.map((repository) => ({
			repository,
			score: repositorySearchScore(repository, trimmed),
		}))
		.filter((result) => result.score > 0)
		.sort(
			(left, right) =>
				right.score - left.score ||
				right.repository.updatedAt.localeCompare(left.repository.updatedAt) ||
				left.repository.name.localeCompare(right.repository.name),
		)
		.map((result) => result.repository)
}

function repositorySearchScore(
	repository: RepositorySummary,
	normalizedQuery: string,
) {
	const fields = [
		{ value: repository.name, weight: 100 },
		{ value: repository.repositoryName, weight: 90 },
		{ value: repository.owner, weight: 80 },
		{ value: repository.description, weight: 60 },
		{ value: repository.githubUrl ?? "", weight: 40 },
		{ value: repository.searchText, weight: 30 },
	]
	return Math.max(
		...fields.map(({ value, weight }) => {
			const score = fuzzyScore(normalizeSearchValue(value), normalizedQuery)
			return score * weight
		}),
	)
}

function fuzzyScore(value: string, query: string) {
	if (!value || !query) return 0
	if (value === query) return 1
	if (value.startsWith(query)) return 0.9
	if (value.includes(query)) return 0.75
	const queryWords = query.split(" ").filter(Boolean)
	if (
		queryWords.length > 1 &&
		queryWords.every((word) => value.includes(word))
	) {
		return 0.65
	}
	return subsequenceScore(value, query)
}

function subsequenceScore(value: string, query: string) {
	let queryIndex = 0
	let firstMatch = -1
	let lastMatch = -1
	for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
		if (value[valueIndex] !== query[queryIndex]) continue
		if (firstMatch === -1) firstMatch = valueIndex
		lastMatch = valueIndex
		queryIndex += 1
		if (queryIndex === query.length) break
	}
	if (queryIndex !== query.length || firstMatch === -1) return 0
	const span = lastMatch - firstMatch + 1
	return Math.max(0.15, query.length / span / 2)
}

function normalizeSearchValue(value = "") {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
}
