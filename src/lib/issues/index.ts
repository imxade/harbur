import type { Actor, RepositoryManifest } from "../types"
import { canMaintainRepository } from "../auth"

export type IssueState = "open" | "closed"
type IssueComment = {
	id: string
	authorEmail: string
	body: string
	createdAt: string
	updatedAt?: string
	editedAt?: string
}
export type IssueRecord = {
	id: string
	number: number
	authorEmail: string
	title: string
	body: string
	state: IssueState
	labels: string[]
	comments: IssueComment[]
	createdAt: string
	updatedAt: string
	editedAt?: string
}

export function extractMentions(markdown: string) {
	return [
		...new Set(
			(markdown.match(/@([a-zA-Z0-9][\w.-]{1,62})/g) ?? []).map((mention) =>
				mention.slice(1).toLowerCase(),
			),
		),
	]
}

export function assertIssueLabels(
	issueLabels: string[],
	repository: RepositoryManifest,
) {
	const allowed = new Set(repository.labels.map((label) => label.id))
	for (const label of issueLabels) {
		if (!allowed.has(label)) throw new Error(`Unknown label: ${label}`)
	}
}

function canChangeIssueState(
	actor: Actor,
	repository: RepositoryManifest,
	issue: IssueRecord,
) {
	if (canMaintainRepository(actor, repository, "triage")) {
		return true
	}
	return (
		repository.policy.allowUserCloseOwnIssues &&
		actor.email.toLowerCase() === issue.authorEmail.toLowerCase()
	)
}

export function transitionIssueState(
	actor: Actor,
	repository: RepositoryManifest,
	issue: IssueRecord,
	state: IssueState,
	now = new Date().toISOString(),
) {
	if (!repository.policy.issuesEnabled) throw new Error("Issues are disabled.")
	if (!canChangeIssueState(actor, repository, issue)) {
		throw new Error("Issue state change is not permitted.")
	}
	return { ...issue, state, updatedAt: now }
}
