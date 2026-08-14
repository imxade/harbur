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
	baseRepositoryZipFileId?: string
	proposalZipSha256?: string
	reviewedBy?: string
	reviewedBaseRepositoryZipFileId?: string
	reviewedProposalZipFileId?: string
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
		if (before && after && !repositoryFilesEqual(before, after)) {
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

function repositoryFilesEqual(left: RepositoryFile, right: RepositoryFile) {
	if (left.size !== right.size) return false
	const leftBytes = repositoryFileBytes(left)
	const rightBytes = repositoryFileBytes(right)
	if (leftBytes.byteLength !== rightBytes.byteLength) return false
	for (let index = 0; index < leftBytes.byteLength; index += 1) {
		if (leftBytes[index] !== rightBytes[index]) return false
	}
	return true
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
		(!pr.reviewedBy ||
			pr.reviewedBy === pr.authorEmail ||
			!pr.reviewedBaseRepositoryZipFileId ||
			!pr.reviewedProposalZipFileId)
	) {
		throw new Error("Review by another maintainer is required.")
	}
}
