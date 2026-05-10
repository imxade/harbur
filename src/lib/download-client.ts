export type DownloadFile = {
	blob: Blob
	name: string
}

export function saveBlobAsFile(blob: Blob, name: string) {
	const url = URL.createObjectURL(blob)
	const anchor = document.createElement("a")
	anchor.href = url
	anchor.download = name
	anchor.click()
	URL.revokeObjectURL(url)
}

export function saveDownloadFile(download: DownloadFile) {
	saveBlobAsFile(download.blob, download.name)
}
