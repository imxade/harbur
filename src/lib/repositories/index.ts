import { APP_SCHEMA } from "../app-config"
import { DEFAULT_REPOSITORY_POLICY } from "../settings"
import type {
	GitHubMirror,
	RepositoryFile,
	RepositoryManifest,
	RepositoryPolicy,
} from "../types"
import { canExportRepositoryPath } from "../security/paths"

export type RepositorySnapshotInput = {
	owner: string
	name: string
	description?: string
	rootFolderId: string
	vcs?: RepositoryManifest["vcs"]
	visibility?: RepositoryManifest["visibility"]
	policy?: Partial<RepositoryPolicy>
	files: RepositoryFile[]
	githubMirror?: GitHubMirror
	now?: string
}

const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

export function assertRepositoryName(name: string) {
	if (!REPOSITORY_NAME_PATTERN.test(name)) {
		throw new Error(
			"Repository names may only contain letters, numbers, dots, underscores, and hyphens, and must start with a letter or number.",
		)
	}
}

export function createRepositoryManifest(
	input: RepositorySnapshotInput,
): RepositoryManifest {
	assertRepositoryName(input.name)
	const now = input.now ?? new Date().toISOString()
	return {
		schema: APP_SCHEMA.repository,
		id: `${input.owner}/${input.name}`,
		owner: input.owner,
		name: input.name,
		description: input.description,
		defaultBranch: "main",
		vcs: input.vcs ?? "folder",
		visibility: input.visibility ?? "public",
		rootFolderId: input.rootFolderId,
		policy: { ...DEFAULT_REPOSITORY_POLICY, ...input.policy },
		maintainers: [],
		access: [],
		githubMirror: input.githubMirror,
		labels: [
			{ id: "bug", name: "bug", color: "#d73a49" },
			{ id: "enhancement", name: "enhancement", color: "#2ea44f" },
			{ id: "question", name: "question", color: "#0366d6" },
		],
		archived: false,
		createdAt: now,
		updatedAt: now,
	}
}

export function filesForDownload(files: RepositoryFile[]) {
	return files.filter((file) => canExportRepositoryPath(file.path))
}

export function repositoryFileFromBytes({
	path,
	bytes,
	modifiedAt,
}: {
	path: string
	bytes: Uint8Array
	modifiedAt?: string
}): RepositoryFile {
	return {
		path,
		...repositoryContentValue(bytes),
		size: bytes.byteLength,
		contentHash: contentHashForBytes(bytes),
		modifiedAt,
	}
}

export function contentHashForBytes(content: string | Uint8Array) {
	const bytes =
		typeof content === "string" ? new TextEncoder().encode(content) : content
	let hash = 0x811c9dc5
	for (const byte of bytes) {
		hash ^= byte
		hash = Math.imul(hash, 0x01000193)
	}
	return (hash >>> 0).toString(16).padStart(8, "0")
}

export function repositoryFileBytes(
	file: Pick<RepositoryFile, "content" | "encoding">,
) {
	if (typeof file.content !== "string") return file.content
	if (file.encoding === "base64") return base64ToBytes(file.content)
	return new TextEncoder().encode(file.content)
}

export function repositoryFileText(
	file: Pick<RepositoryFile, "content" | "encoding"> | undefined,
) {
	if (!file) return ""
	if (typeof file.content === "string" && file.encoding !== "base64") {
		return file.content
	}
	const bytes = repositoryFileBytes(file)
	if (bytes.includes(0)) return null
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
	} catch {
		return null
	}
}

export function bytesToBase64(bytes: Uint8Array) {
	let binary = ""
	const chunkSize = 0x8000
	for (let index = 0; index < bytes.length; index += chunkSize) {
		binary += String.fromCharCode(...bytes.slice(index, index + chunkSize))
	}
	return btoa(binary)
}

function repositoryContentValue(content: Uint8Array) {
	if (content.includes(0)) {
		return { content: bytesToBase64(content), encoding: "base64" as const }
	}
	try {
		return {
			content: new TextDecoder("utf-8", { fatal: true }).decode(content),
			encoding: "utf8" as const,
		}
	} catch {
		return { content: bytesToBase64(content), encoding: "base64" as const }
	}
}

function base64ToBytes(value: string) {
	const binary = atob(value)
	const bytes = new Uint8Array(binary.length)
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index)
	}
	return bytes
}
