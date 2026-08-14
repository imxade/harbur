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
	return path
		.normalize("NFC")
		.replaceAll("\\", "/")
		.replace(/^\/+/, "")
		.replace(/\/+/g, "/")
}

export function isUnsafePath(path: string) {
	const normalized = normalizeRepositoryPath(path)
	const segments = normalized.split("/")
	return (
		path !== path.normalize("NFC") ||
		path.startsWith("/") ||
		path.startsWith("\\") ||
		/^[A-Za-z]:[\\/]/.test(path) ||
		normalized === "" ||
		normalized.length > 4096 ||
		segments.length > 256 ||
		segments.some(
			(segment) =>
				segment === "." ||
				segment === ".." ||
				segment.length > 255 ||
				containsControlCharacter(segment) ||
				/[:*?"<>|]/.test(segment) ||
				/[ .]$/.test(segment) ||
				isWindowsReservedName(segment),
		)
	)
}

function containsControlCharacter(value: string) {
	return [...value].some((character) => {
		const code = character.charCodeAt(0)
		return code <= 0x1f || code === 0x7f
	})
}

function isWindowsReservedName(segment: string) {
	const stem = segment.split(".")[0]?.toUpperCase() ?? ""
	return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)
}

export function isBlockedVcsPath(path: string) {
	return normalizeRepositoryPath(path)
		.split("/")
		.some((segment) =>
			[...BLOCKED_SEGMENTS].some(
				(blocked) => blocked.toLowerCase() === segment.toLowerCase(),
			),
		)
}

function isAppMetadataPath(path: string) {
	return normalizeRepositoryPath(path)
		.split("/")
		.some((segment) =>
			[...METADATA_SEGMENTS].some(
				(blocked) => blocked.toLowerCase() === segment.toLowerCase(),
			),
		)
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
