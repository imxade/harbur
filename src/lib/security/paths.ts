const BLOCKED_SEGMENTS = new Set([
	".git",
	".hg",
	".svn",
	"_FOSSIL_",
	".fslckout",
	".fossil-settings",
	"CVS",
])

const METADATA_SEGMENTS = new Set([
	"issues",
	"pulls",
	"activity",
	"feeds",
	"audit",
	"settings",
	"credentials",
])

export function normalizeRepositoryPath(path: string) {
	return path.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+/g, "/")
}

export function isUnsafePath(path: string) {
	const normalized = normalizeRepositoryPath(path)
	return (
		normalized === "" ||
		normalized.startsWith("../") ||
		normalized.includes("/../") ||
		normalized.endsWith("/..") ||
		normalized.includes("\0")
	)
}

export function isBlockedVcsPath(path: string) {
	return normalizeRepositoryPath(path)
		.split("/")
		.some((segment) => BLOCKED_SEGMENTS.has(segment))
}

function isAppMetadataPath(path: string) {
	return normalizeRepositoryPath(path)
		.split("/")
		.some((segment) => METADATA_SEGMENTS.has(segment))
}

export function assertRepositoryContentPath(path: string) {
	if (isUnsafePath(path)) throw new Error(`Unsafe repository path: ${path}`)
	if (isBlockedVcsPath(path)) throw new Error(`Blocked VCS path: ${path}`)
}

export function canExportRepositoryPath(path: string) {
	return (
		!isUnsafePath(path) && !isBlockedVcsPath(path) && !isAppMetadataPath(path)
	)
}
