import type { AppSettings, RepositoryFile } from "../types"
import {
	isBlockedVcsPath,
	isUnsafePath,
	normalizeRepositoryPath,
} from "../security/paths"
import { contentHashForBytes, repositoryFileBytes } from "./index"
import { normalizeSafeUploadPathEntries } from "./upload-paths"

export type UploadedRepositoryFile = {
	path: string
	content: RepositoryFile["content"]
	encoding?: RepositoryFile["encoding"]
	modifiedAt?: string
}

export type UploadedRepositoryFileMetadata = Pick<
	RepositoryFile,
	"path" | "size" | "contentHash" | "modifiedAt"
> &
	Partial<Pick<RepositoryFile, "content" | "encoding">>

export function prepareRepositoryUploadFiles(
	files: UploadedRepositoryFile[],
	settings: AppSettings,
	kind: "repository" | "pull-request",
) {
	const candidates = normalizeSafeUploadPathEntries(files)
	const normalized = candidates.map((file) => {
		const bytes = repositoryFileBytesForUpload(file)
		return {
			path: file.path,
			content: file.content,
			encoding: file.encoding,
			size: bytes.byteLength,
			contentHash: contentHashForBytes(bytes),
			modifiedAt: file.modifiedAt,
		} satisfies RepositoryFile
	})

	assertNoDuplicatePaths(normalized)
	assertUploadLimits(normalized, settings, kind)
	return normalized
}

export function prepareRepositoryUploadMetadata(
	files: UploadedRepositoryFileMetadata[],
	settings: AppSettings,
	kind: "repository" | "pull-request",
) {
	const normalized = files
		.map((file) => {
			assertArchivePath(file.path)
			if (file.content !== undefined) {
				const bytes = repositoryFileBytesForUpload({
					path: file.path,
					content: file.content,
					encoding: file.encoding,
				})
				if (
					bytes.byteLength !== file.size ||
					contentHashForBytes(bytes) !== file.contentHash
				) {
					throw new Error(`Upload metadata does not match ${file.path}.`)
				}
			}
			return {
				path: file.path,
				size: file.size,
				contentHash: file.contentHash,
				modifiedAt: file.modifiedAt,
				content: file.content,
				encoding: file.encoding,
			} satisfies UploadedRepositoryFileMetadata
		})
		.sort((left, right) => left.path.localeCompare(right.path))
	assertNoDuplicatePaths(normalized)
	assertUploadLimits(normalized, settings, kind)
	return normalized
}

function assertArchivePath(path: string) {
	if (normalizeRepositoryPath(path) !== path) {
		throw new Error(`Unsafe repository path: ${path}`)
	}
	if (isUnsafePath(path)) throw new Error(`Unsafe repository path: ${path}`)
	if (isBlockedVcsPath(path)) throw new Error(`Blocked VCS path: ${path}`)
}

function repositoryFileBytesForUpload(file: UploadedRepositoryFile) {
	try {
		return repositoryFileBytes(file)
	} catch {
		throw new Error(`Could not decode upload file: ${file.path}`)
	}
}

function assertNoDuplicatePaths(files: Array<Pick<RepositoryFile, "path">>) {
	const seen = new Set<string>()
	for (const file of files) {
		if (seen.has(file.path)) {
			throw new Error(`Duplicate repository path: ${file.path}`)
		}
		seen.add(file.path)
	}
}

function assertUploadLimits(
	files: Array<Pick<RepositoryFile, "path" | "size">>,
	settings: AppSettings,
	kind: "repository" | "pull-request",
) {
	if (!files.length) throw new Error("Upload has no accepted files.")
	const totalBytes = files.reduce((total, file) => total + file.size, 0)
	const maxTotalBytes =
		kind === "pull-request"
			? settings.uploadLimits.maxPrUploadBytes
			: settings.uploadLimits.maxRepoUploadBytes
	if (files.length > settings.uploadLimits.maxFilesPerUpload) {
		throw new Error(
			`Upload has ${files.length} files; limit is ${settings.uploadLimits.maxFilesPerUpload}.`,
		)
	}
	if (totalBytes > maxTotalBytes) {
		throw new Error(`Upload is ${totalBytes} bytes; limit is ${maxTotalBytes}.`)
	}
	const oversized = files.find(
		(file) => file.size > settings.uploadLimits.maxSingleFileBytes,
	)
	if (oversized) {
		throw new Error(
			`${oversized.path} exceeds the ${settings.uploadLimits.maxSingleFileBytes} byte single-file limit.`,
		)
	}
}
