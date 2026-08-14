import { unzip, zip, type AsyncZippable } from "fflate"
import {
	isBlockedVcsPath,
	isUnsafePath,
	normalizeRepositoryPath,
} from "./security/paths"

export type ZipSourceFile = {
	path: string
	bytes: Uint8Array
	modifiedAt?: string
}

export async function zipFilesToBlob({
	files,
	level,
	onProgress,
}: {
	files: ZipSourceFile[]
	level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
	onProgress?: (progress: {
		current: number
		total: number
		message: string
	}) => void
}) {
	const data: AsyncZippable = {}
	for (const [index, file] of files.entries()) {
		onProgress?.({
			current: index + 1,
			total: files.length,
			message: `Preparing ${index + 1}/${files.length} files`,
		})
		data[file.path] = [
			file.bytes,
			{
				level,
				mtime: validZipDate(file.modifiedAt),
			},
		]
	}
	const bytes = await zipBytes(data, { level })
	return new Blob([bytes as unknown as BlobPart], { type: "application/zip" })
}

export type ZipExtractionLimits = {
	maxArchiveBytes: number
	maxTotalBytes: number
	maxSingleFileBytes: number
	maxFiles: number
	maxCompressionRatio?: number
}

const DEFAULT_EXTRACTION_LIMITS: ZipExtractionLimits = {
	maxArchiveBytes: 512 * 1024 * 1024,
	maxTotalBytes: 512 * 1024 * 1024,
	maxSingleFileBytes: 100 * 1024 * 1024,
	maxFiles: 20_000,
	maxCompressionRatio: 100,
}

export async function unzipBlob(
	blob: Blob,
	limits: ZipExtractionLimits = DEFAULT_EXTRACTION_LIMITS,
) {
	if (blob.size > limits.maxArchiveBytes) {
		throw new Error("ZIP exceeds the compressed archive size limit.")
	}
	return await unzipBytes(new Uint8Array(await blob.arrayBuffer()), limits)
}

export async function unzipBytes(
	bytes: Uint8Array,
	limits: ZipExtractionLimits = DEFAULT_EXTRACTION_LIMITS,
) {
	const expectedEntries = inspectZipArchive(bytes, limits)
	const entries = await new Promise<Record<string, Uint8Array>>(
		(resolve, reject) => {
			unzip(bytes, (error, data) => {
				if (error) {
					reject(error)
					return
				}
				resolve(data)
			})
		},
	)
	const extracted = Object.entries(entries)
		.filter(([path]) => !path.endsWith("/"))
		.map(([path, bytes]) => ({ path, bytes }))
		.sort((left, right) => left.path.localeCompare(right.path))
	if (
		extracted.length !== expectedEntries.size ||
		extracted.some(
			(entry) => expectedEntries.get(entry.path) !== entry.bytes.byteLength,
		)
	) {
		throw new Error("ZIP entries did not match the validated directory.")
	}
	return extracted
}

function inspectZipArchive(bytes: Uint8Array, limits: ZipExtractionLimits) {
	if (bytes.byteLength > limits.maxArchiveBytes) {
		throw new Error("ZIP exceeds the compressed archive size limit.")
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const eocdOffset = findEndOfCentralDirectory(view)
	const diskNumber = view.getUint16(eocdOffset + 4, true)
	const directoryDisk = view.getUint16(eocdOffset + 6, true)
	const diskEntryCount = view.getUint16(eocdOffset + 8, true)
	const entryCount = view.getUint16(eocdOffset + 10, true)
	const directoryBytes = view.getUint32(eocdOffset + 12, true)
	const directoryOffset = view.getUint32(eocdOffset + 16, true)
	const commentBytes = view.getUint16(eocdOffset + 20, true)
	if (
		diskNumber !== 0 ||
		directoryDisk !== 0 ||
		diskEntryCount !== entryCount
	) {
		throw new Error("Multi-disk ZIP archives are not supported.")
	}
	if (eocdOffset + 22 + commentBytes !== bytes.byteLength) {
		throw new Error("ZIP end-of-central-directory record is malformed.")
	}
	if (
		entryCount === 0xffff ||
		directoryBytes === 0xffffffff ||
		directoryOffset === 0xffffffff
	) {
		throw new Error("ZIP64 archives are not supported.")
	}
	if (entryCount > limits.maxFiles) {
		throw new Error(
			`ZIP has ${entryCount} entries; limit is ${limits.maxFiles}.`,
		)
	}
	if (directoryOffset + directoryBytes > eocdOffset) {
		throw new Error("ZIP central directory is malformed.")
	}
	const seen = new Set<string>()
	const expectedFiles = new Map<string, number>()
	let totalBytes = 0
	let offset = directoryOffset
	for (let index = 0; index < entryCount; index += 1) {
		if (
			offset + 46 > eocdOffset ||
			view.getUint32(offset, true) !== 0x02014b50
		) {
			throw new Error("ZIP central directory entry is malformed.")
		}
		const flags = view.getUint16(offset + 8, true)
		const method = view.getUint16(offset + 10, true)
		const compressedBytes = view.getUint32(offset + 20, true)
		const uncompressedBytes = view.getUint32(offset + 24, true)
		const nameBytes = view.getUint16(offset + 28, true)
		const extraBytes = view.getUint16(offset + 30, true)
		const commentBytes = view.getUint16(offset + 32, true)
		const externalAttributes = view.getUint32(offset + 38, true)
		const localHeaderOffset = view.getUint32(offset + 42, true)
		const nextOffset = offset + 46 + nameBytes + extraBytes + commentBytes
		if (nextOffset > eocdOffset) {
			throw new Error("ZIP central directory entry is truncated.")
		}
		if (flags & 0x1) throw new Error("Encrypted ZIP entries are not supported.")
		if (method !== 0 && method !== 8) {
			throw new Error(`Unsupported ZIP compression method: ${method}.`)
		}
		const rawName = bytes.subarray(offset + 46, offset + 46 + nameBytes)
		if (!(flags & 0x800) && rawName.some((byte) => byte > 0x7f)) {
			throw new Error("ZIP entry names must use UTF-8.")
		}
		const path = new TextDecoder("utf-8", { fatal: true }).decode(rawName)
		const isDirectory = path.endsWith("/")
		assertMatchingLocalHeader({
			bytes,
			view,
			directoryOffset,
			localHeaderOffset,
			centralFlags: flags,
			centralMethod: method,
			centralPath: path,
			compressedBytes,
		})
		const unixMode = externalAttributes >>> 16
		if ((unixMode & 0xf000) === 0xa000) {
			throw new Error(`ZIP symlinks are not allowed: ${path}`)
		}
		if (!isDirectory) {
			assertSafeZipEntryPath(path, seen)
			expectedFiles.set(path, uncompressedBytes)
			if (uncompressedBytes > limits.maxSingleFileBytes) {
				throw new Error(`ZIP entry exceeds the single-file limit: ${path}`)
			}
			totalBytes += uncompressedBytes
			if (totalBytes > limits.maxTotalBytes) {
				throw new Error("ZIP exceeds the total uncompressed size limit.")
			}
			const ratio =
				uncompressedBytes === 0
					? 1
					: uncompressedBytes / Math.max(1, compressedBytes)
			if (ratio > (limits.maxCompressionRatio ?? 100)) {
				throw new Error(`ZIP entry compression ratio is unsafe: ${path}`)
			}
		} else if (compressedBytes !== 0 || uncompressedBytes !== 0) {
			throw new Error(`ZIP directory entry contains data: ${path}`)
		}
		offset = nextOffset
	}
	if (offset !== directoryOffset + directoryBytes) {
		throw new Error("ZIP central directory size did not match its entries.")
	}
	return expectedFiles
}

function assertMatchingLocalHeader({
	bytes,
	view,
	directoryOffset,
	localHeaderOffset,
	centralFlags,
	centralMethod,
	centralPath,
	compressedBytes,
}: {
	bytes: Uint8Array
	view: DataView
	directoryOffset: number
	localHeaderOffset: number
	centralFlags: number
	centralMethod: number
	centralPath: string
	compressedBytes: number
}) {
	if (
		localHeaderOffset + 30 > directoryOffset ||
		view.getUint32(localHeaderOffset, true) !== 0x04034b50
	) {
		throw new Error("ZIP local file header is malformed.")
	}
	const flags = view.getUint16(localHeaderOffset + 6, true)
	const method = view.getUint16(localHeaderOffset + 8, true)
	const nameBytes = view.getUint16(localHeaderOffset + 26, true)
	const extraBytes = view.getUint16(localHeaderOffset + 28, true)
	const nameStart = localHeaderOffset + 30
	const dataStart = nameStart + nameBytes + extraBytes
	if (
		dataStart + compressedBytes > directoryOffset ||
		flags !== centralFlags ||
		method !== centralMethod
	) {
		throw new Error("ZIP local file header does not match its directory entry.")
	}
	const localPath = new TextDecoder("utf-8", { fatal: true }).decode(
		bytes.subarray(nameStart, nameStart + nameBytes),
	)
	if (localPath !== centralPath) {
		throw new Error("ZIP local file path does not match its directory entry.")
	}
}

function findEndOfCentralDirectory(view: DataView) {
	const minimum = Math.max(0, view.byteLength - 65_557)
	for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
		if (view.getUint32(offset, true) === 0x06054b50) return offset
	}
	throw new Error("ZIP end-of-central-directory record is missing.")
}

function assertSafeZipEntryPath(path: string, seen: Set<string>) {
	if (
		normalizeRepositoryPath(path) !== path ||
		isUnsafePath(path) ||
		isBlockedVcsPath(path)
	) {
		throw new Error(`Unsafe ZIP entry path: ${path}`)
	}
	const collisionKey = path.normalize("NFC").toLocaleLowerCase("en-US")
	if (seen.has(collisionKey)) {
		throw new Error(`Duplicate or colliding ZIP entry path: ${path}`)
	}
	seen.add(collisionKey)
}

function zipBytes(
	data: AsyncZippable,
	options: { level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 },
) {
	return new Promise<Uint8Array>((resolve, reject) => {
		zip(data, options, (error, bytes) => {
			if (error) {
				reject(error)
				return
			}
			resolve(bytes)
		})
	})
}

function validZipDate(value: string | undefined) {
	if (!value) return undefined
	const date = new Date(value)
	return Number.isFinite(date.getTime()) ? date : undefined
}
