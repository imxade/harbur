import { APP_STORAGE, APP_UPLOAD } from "./app-config"
import {
	bytesToBase64,
	contentHashForBytes,
	repositoryFileBytes,
	repositoryFileFromBytes,
} from "./repositories"
import {
	filterGitignoredUploadEntries,
	normalizeSafeUploadPathEntries,
} from "./repositories/upload-paths"
import type { AppSettings, RepositoryFile } from "./types"
import { unzipBlob, zipFilesToBlob } from "./zip"

export type ClientUploadArchive = {
	blob: Blob
	files: ClientUploadFileMetadata[]
}

export type ClientUploadFileMetadata = {
	path: string
	size: number
	contentHash: string
	modifiedAt?: string
	content?: string
	encoding?: "utf8" | "base64"
}

export type ClientUploadProgress = {
	phase: "preparing" | "zipping" | "uploading"
	current: number
	total: number
	message: string
}

export type ClientUploadSnapshot = {
	files: RepositoryFile[]
}

export async function prepareClientUploadArchive({
	files,
	settings,
	kind,
	onProgress,
}: {
	files: File[]
	settings: AppSettings
	kind: "repository" | "pull-request"
	onProgress?: (progress: ClientUploadProgress) => void
}): Promise<ClientUploadArchive> {
	const snapshot = await prepareClientUploadSnapshot({
		files,
		settings,
		kind,
		onProgress,
	})
	return {
		blob: await buildClientZipBlob({
			files: snapshot.files,
			onProgress,
		}),
		files: clientUploadMetadata(snapshot.files, { includeSidecars: true }),
	}
}

export async function prepareClientUploadSnapshot({
	files,
	settings,
	kind,
	onProgress,
}: {
	files: File[]
	settings: AppSettings
	kind: "repository" | "pull-request"
	onProgress?: (progress: ClientUploadProgress) => void
}): Promise<ClientUploadSnapshot> {
	const acceptedFiles = await acceptedClientUploadFiles(files)
	assertClientUploadLimits(acceptedFiles, settings, kind)
	const repositoryFiles: RepositoryFile[] = []
	for (const [index, { file, path }] of acceptedFiles.entries()) {
		onProgress?.({
			phase: "preparing",
			current: index + 1,
			total: acceptedFiles.length,
			message: `Reading ${index + 1}/${acceptedFiles.length} files`,
		})
		repositoryFiles.push(
			repositoryFileFromBytes({
				path,
				bytes: new Uint8Array(await file.arrayBuffer()),
				modifiedAt: new Date(file.lastModified).toISOString(),
			}),
		)
	}
	return {
		files: repositoryFiles.sort((left, right) =>
			left.path.localeCompare(right.path),
		),
	}
}

export async function buildClientZipBlob({
	files,
	onProgress,
}: {
	files: RepositoryFile[]
	onProgress?: (progress: ClientUploadProgress) => void
}) {
	const zipFiles = files.map((file) => ({
		path: file.path,
		bytes: repositoryFileBytes(file),
		modifiedAt: file.modifiedAt,
	}))
	return await zipFilesToBlob({
		files: zipFiles,
		level: APP_UPLOAD.clientZipCompressionLevel,
		onProgress: (metadata) => {
			onProgress?.({
				phase: "zipping",
				current: metadata.current,
				total: files.length,
				message: metadata.message,
			})
		},
	})
}

export async function repositoryFilesFromZipBlob(blob: Blob) {
	const files = await Promise.all(
		(await unzipBlob(blob)).map((entry) =>
			repositoryFileFromBytes({
				path: entry.path,
				bytes: entry.bytes,
			}),
		),
	)
	return files.sort((left, right) => left.path.localeCompare(right.path))
}

export function clientUploadMetadata(
	files: RepositoryFile[],
	options: { includeSidecars?: boolean } = {},
): ClientUploadFileMetadata[] {
	let readmeAssetCount = 0
	let readmeAssetBytes = 0
	return files.map((file) => {
		const bytes = repositoryFileBytes(file)
		const sidecar = options.includeSidecars
			? uploadSidecarContent(file.path, bytes, {
					readmeAssetCount,
					readmeAssetBytes,
				})
			: {}
		if (sidecar.includedAsset) {
			readmeAssetCount += 1
			readmeAssetBytes += file.size
		}
		return {
			path: file.path,
			size: file.size,
			contentHash: file.contentHash ?? contentHashForBytes(bytes),
			modifiedAt: file.modifiedAt,
			content: sidecar.content,
			encoding: sidecar.encoding,
		}
	})
}

export function pullRequestBaseSidecarMetadata(
	files: RepositoryFile[],
): ClientUploadFileMetadata[] {
	const sidecars: ClientUploadFileMetadata[] = []
	let bytes = 0
	for (const file of files) {
		if (sidecars.length >= APP_STORAGE.pullRequestBaseSidecarMaxFiles) break
		if (bytes + file.size > APP_STORAGE.pullRequestBaseSidecarMaxBytes) {
			continue
		}
		bytes += file.size
		const fileBytes = repositoryFileBytes(file)
		sidecars.push({
			path: file.path,
			size: file.size,
			contentHash: file.contentHash ?? contentHashForBytes(fileBytes),
			modifiedAt: file.modifiedAt,
			...contentValue(fileBytes),
		})
	}
	return sidecars
}

export function uploadBlobToGoogleDriveSession({
	uploadUrl,
	blob,
	onProgress,
}: {
	uploadUrl: string
	blob: Blob
	onProgress?: (progress: ClientUploadProgress) => void
}) {
	return new Promise<{ id: string; name: string; webViewLink?: string }>(
		(resolve, reject) => {
			const request = new XMLHttpRequest()
			request.open("PUT", uploadUrl)
			request.setRequestHeader(
				"Content-Type",
				blob.type || "application/octet-stream",
			)
			request.upload.onprogress = (event) => {
				if (!event.lengthComputable) return
				onProgress?.({
					phase: "uploading",
					current: event.loaded,
					total: event.total,
					message: `Uploading ZIP ${formatBytes(event.loaded)} / ${formatBytes(
						event.total,
					)}`,
				})
			}
			request.onerror = () => reject(new Error("ZIP upload failed."))
			request.onload = () => {
				if (request.status < 200 || request.status >= 300) {
					reject(
						new Error(
							`ZIP upload failed (${request.status}): ${request.responseText}`,
						),
					)
					return
				}
				try {
					resolve(JSON.parse(request.responseText))
				} catch {
					reject(new Error("ZIP upload returned invalid JSON."))
				}
			}
			request.send(blob)
		},
	)
}

export async function summarizeClientUploadFiles(files: File[]) {
	const accepted = await acceptedClientUploadFiles(files)
	return {
		selected: files.length,
		accepted: accepted.length,
		acceptedBytes: accepted.reduce((total, { file }) => total + file.size, 0),
	}
}

async function acceptedClientUploadFiles(files: File[]) {
	const candidates = normalizeSafeUploadPathEntries(
		files.map((file) => ({
			file,
			path: browserFilePath(file),
		})),
	)
	if (!candidates.some((file) => file.path === ".gitignore")) return candidates
	return filterGitignoredUploadEntries(
		candidates,
		await gitignoreTextFromClientFiles(candidates),
	)
}

async function gitignoreTextFromClientFiles(
	files: Array<{ file: File; path: string }>,
) {
	return (
		await Promise.all(
			files
				.filter((file) => file.path === ".gitignore")
				.map(async ({ file }) => {
					const bytes = new Uint8Array(await file.arrayBuffer())
					return bytesToUtf8Text(bytes) ?? ""
				}),
		)
	).join("\n")
}

function assertClientUploadLimits(
	files: Array<{ file: File; path: string }>,
	settings: AppSettings,
	kind: "repository" | "pull-request",
) {
	if (!files.length) throw new Error("Upload has no accepted files.")
	const maxTotalBytes =
		kind === "pull-request"
			? settings.uploadLimits.maxPrUploadBytes
			: settings.uploadLimits.maxRepoUploadBytes
	if (files.length > settings.uploadLimits.maxFilesPerUpload) {
		throw new Error(
			`Upload has ${files.length} files; limit is ${settings.uploadLimits.maxFilesPerUpload}.`,
		)
	}
	const totalBytes = files.reduce((total, { file }) => total + file.size, 0)
	if (totalBytes > maxTotalBytes) {
		throw new Error(`Upload is ${totalBytes} bytes; limit is ${maxTotalBytes}.`)
	}
	const oversized = files.find(
		({ file }) => file.size > settings.uploadLimits.maxSingleFileBytes,
	)
	if (oversized) {
		throw new Error(
			`${oversized.path} exceeds the ${settings.uploadLimits.maxSingleFileBytes} byte single-file limit.`,
		)
	}
}

function bytesToUtf8Text(bytes: Uint8Array) {
	if (bytes.includes(0)) return null
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
	} catch {
		return null
	}
}

function browserFilePath(file: File) {
	const withDirectory = file as File & { webkitRelativePath?: string }
	return withDirectory.webkitRelativePath || file.name
}

function uploadSidecarContent(
	path: string,
	bytes: Uint8Array,
	assetState: { readmeAssetCount: number; readmeAssetBytes: number },
): {
	content?: string
	encoding?: "utf8" | "base64"
	includedAsset?: boolean
} {
	if (isRootReadmePath(path)) return contentValue(bytes)
	if (!isReadmeAssetPath(path)) return {}
	if (assetState.readmeAssetCount >= APP_STORAGE.readmeAssetMaxFiles) return {}
	if (
		assetState.readmeAssetBytes + bytes.byteLength >
		APP_STORAGE.readmeAssetMaxBytes
	) {
		return {}
	}
	return { ...contentValue(bytes), includedAsset: true }
}

function contentValue(bytes: Uint8Array) {
	if (bytes.includes(0)) {
		return { content: bytesToBase64(bytes), encoding: "base64" as const }
	}
	try {
		return {
			content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
			encoding: "utf8" as const,
		}
	} catch {
		return { content: bytesToBase64(bytes), encoding: "base64" as const }
	}
}

function isRootReadmePath(path: string) {
	return path.trim().replaceAll("\\", "/").toLowerCase() === "readme.md"
}

function isReadmeAssetPath(path: string) {
	const normalized = path.trim().replaceAll("\\", "/").toLowerCase()
	if (!normalized.startsWith("assets/")) return false
	return /\.(avif|gif|jpe?g|png|svg|webp)$/.test(normalized)
}

function formatBytes(bytes: number) {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
	return `${Math.round(bytes / (1024 * 1024))} MB`
}
