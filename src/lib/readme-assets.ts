import { bytesToBase64, repositoryFileBytes } from "./repositories"

type ReadmeAssetFile = {
	path: string
	content: string | Uint8Array
	encoding?: "utf8" | "base64"
}

export function readmeAssetUrls(files: ReadmeAssetFile[]) {
	const urls: Record<string, string> = {}
	for (const file of files) {
		const assetPath = normalizeReadmeAssetPath(file.path)
		const mimeType = assetPath ? imageMimeType(assetPath) : null
		if (!assetPath || !mimeType) continue
		const base64 =
			file.encoding === "base64" && typeof file.content === "string"
				? file.content
				: bytesToBase64(repositoryFileBytes(file))
		urls[assetPath] = `data:${mimeType};base64,${base64}`
	}
	return urls
}

export function normalizeReadmeAssetPath(path: string) {
	let normalized = path.trim().split("#", 1)[0]?.split("?", 1)[0] ?? ""
	normalized = normalized.replaceAll("\\", "/")
	while (normalized.startsWith("./")) normalized = normalized.slice(2)
	if (normalized.startsWith("/")) normalized = normalized.slice(1)
	if (!normalized.startsWith("assets/")) return null
	const parts = normalized.split("/")
	if (parts.some((part) => !part || part === "." || part === "..")) {
		return null
	}
	return parts.join("/")
}

function imageMimeType(path: string) {
	const extension = path.split(".").pop()?.toLowerCase()
	if (extension === "png") return "image/png"
	if (extension === "jpg" || extension === "jpeg") return "image/jpeg"
	if (extension === "gif") return "image/gif"
	if (extension === "webp") return "image/webp"
	if (extension === "svg") return "image/svg+xml"
	if (extension === "avif") return "image/avif"
	return null
}
