import { unzip, zip, type AsyncZippable } from "fflate"

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

export async function unzipBlob(blob: Blob) {
	return await unzipBytes(new Uint8Array(await blob.arrayBuffer()))
}

export async function unzipBytes(bytes: Uint8Array) {
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
	return Object.entries(entries)
		.filter(([path]) => !path.endsWith("/"))
		.map(([path, bytes]) => ({ path, bytes }))
		.sort((left, right) => left.path.localeCompare(right.path))
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
