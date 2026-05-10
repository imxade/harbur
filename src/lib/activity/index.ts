export type ActivityRecord = {
	id: string
	repositoryId: string
	actorEmail: string
	kind:
		| "repo.created"
		| "issue.created"
		| "issue.closed"
		| "issue.reopened"
		| "issue.commented"
		| "pr.created"
		| "pr.closed"
		| "pr.commented"
		| "pr.merged"
		| "repo.watched"
		| "repo.deleted"
		| "repo.synced"
		| "settings.updated"
	timestamp: string
	message: string
}
