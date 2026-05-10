import ignore from "ignore"
import {
	isBlockedVcsPath,
	isUnsafePath,
	normalizeRepositoryPath,
} from "../security/paths"

export function normalizeSafeUploadPathEntries<T extends { path: string }>(
	files: T[],
) {
	const rootPrefix = commonUploadRoot(files.map((file) => file.path))
	const normalized = files.map((file) => ({
		...file,
		path: normalizeUploadPath(file.path, rootPrefix),
	}))
	for (const file of normalized) assertSafeUploadPath(file.path)
	return normalized.filter((file) => !isBlockedVcsPath(file.path))
}

export function filterGitignoredUploadEntries<T extends { path: string }>(
	files: T[],
	gitignoreText: string,
) {
	if (!gitignoreText.trim()) return files
	const matcher = ignore().add(gitignoreText)
	return files.filter((file) => !matcher.ignores(file.path))
}

function normalizeUploadPath(path: string, rootPrefix: string) {
	const normalized = normalizeRepositoryPath(path)
	return rootPrefix && normalized.startsWith(`${rootPrefix}/`)
		? normalized.slice(rootPrefix.length + 1)
		: normalized
}

function commonUploadRoot(paths: string[]) {
	const segments = paths.map((path) => normalizeRepositoryPath(path).split("/"))
	if (!segments.length || segments.some((parts) => parts.length < 2)) return ""
	const [firstRoot] = segments[0] ?? []
	if (!firstRoot) return ""
	return segments.every(([root]) => root === firstRoot) ? firstRoot : ""
}

function assertSafeUploadPath(path: string) {
	if (isUnsafePath(path)) throw new Error(`Unsafe repository path: ${path}`)
}
