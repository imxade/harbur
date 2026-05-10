import type { Actor, RepositoryFile, RepositoryManifest } from "../types"
import {
	assertRepositoryContentPath,
	normalizeRepositoryPath,
} from "../security/paths"
import { canMaintainRepository } from "../auth"
import { contentHashForBytes, repositoryFileBytes } from "../repositories"

export type PullRequestState = "open" | "closed" | "merged"
export type PullRequestRecord = {
	id: string
	number: number
	authorEmail: string
	title: string
	body: string
	state: PullRequestState
	reviewedBy?: string
	createdAt: string
	updatedAt: string
	editedAt?: string
}

export type FileDiff = {
	path: string
	status: "added" | "modified" | "deleted" | "unchanged"
	beforeHash?: string
	afterHash?: string
}

function indexFiles(files: RepositoryFile[]) {
	return new Map(
		files.map((file) => [
			normalizeRepositoryPath(file.path),
			{
				...file,
				contentHash:
					file.contentHash ?? contentHashForBytes(repositoryFileBytes(file)),
			},
		]),
	)
}

export function diffRepositoryFiles(
	baseFiles: RepositoryFile[],
	uploadedFiles: RepositoryFile[],
): FileDiff[] {
	for (const file of uploadedFiles) assertRepositoryContentPath(file.path)
	const base = indexFiles(baseFiles)
	const incoming = indexFiles(uploadedFiles)
	const paths = [...new Set([...base.keys(), ...incoming.keys()])].sort()

	return paths.map((path) => {
		const before = base.get(path)
		const after = incoming.get(path)
		if (!before && after) {
			return { path, status: "added", afterHash: after.contentHash }
		}
		if (before && !after) {
			return { path, status: "deleted", beforeHash: before.contentHash }
		}
		if (before?.contentHash !== after?.contentHash) {
			return {
				path,
				status: "modified",
				beforeHash: before?.contentHash,
				afterHash: after?.contentHash,
			}
		}
		return {
			path,
			status: "unchanged",
			beforeHash: before?.contentHash,
			afterHash: after?.contentHash,
		}
	})
}

export function compactPullRequestChanges(
	baseFiles: RepositoryFile[],
	uploadedFiles: RepositoryFile[],
) {
	const changed = new Set(
		diffRepositoryFiles(baseFiles, uploadedFiles)
			.filter((diff) => diff.status === "added" || diff.status === "modified")
			.map((diff) => diff.path),
	)
	return uploadedFiles.filter((file) =>
		changed.has(normalizeRepositoryPath(file.path)),
	)
}

export function applyPullRequestFiles(
	baseFiles: RepositoryFile[],
	pullRequest: { diff: FileDiff[]; files: RepositoryFile[] },
) {
	const output = new Map(baseFiles.map((file) => [file.path, file]))
	for (const fileDiff of pullRequest.diff) {
		if (fileDiff.status === "deleted") output.delete(fileDiff.path)
	}
	for (const file of pullRequest.files) {
		assertRepositoryContentPath(file.path)
		output.set(file.path, file)
	}
	return [...output.values()].sort((left, right) =>
		left.path.localeCompare(right.path),
	)
}

export function assertCanMergePullRequest(
	actor: Actor,
	repository: RepositoryManifest,
	pr: PullRequestRecord,
) {
	if (!repository.policy.prsEnabled)
		throw new Error("Pull requests are disabled.")
	if (repository.archived)
		throw new Error("Archived repositories cannot be merged.")
	if (!canMaintainRepository(actor, repository, "merge")) {
		throw new Error("Merge permission is required.")
	}
	if (
		repository.policy.requiredStatusForMerge === "reviewed" &&
		(!pr.reviewedBy || pr.reviewedBy === pr.authorEmail)
	) {
		throw new Error("Review by another maintainer is required.")
	}
}
