import { Link, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import type { FormEvent } from "react"
import { isAnonymousEmail } from "../../lib/auth"
import { displayOwnerName } from "../../lib/users"
import {
	ChatTimeline,
	EditableThreadTitle,
	type ChatTimelineMessage,
} from "./ThreadComponents"

type PendingComment = ChatTimelineMessage & { issueNumber: number }

export function IssuesPanel({
	actorEmail,
	owner,
	repo,
	repository,
	issues,
	users,
	itemNumber,
	onCreateIssue,
	onComment,
	onEditMessage,
	onEditTitle,
	onTransition,
	onSignIn,
}: {
	actorEmail: string
	owner: string
	repo: string
	repository: {
		id: string
		labels: Array<{ id: string; name: string }>
		policy: {
			issuesEnabled: boolean
			allowUserCloseOwnIssues: boolean
		}
		maintainers: Array<{ email: string; permissions?: string[] }>
		access: Array<{ email: string }>
	}
	users: Record<string, { ownerName: string }>
	issues: Array<{
		id: string
		number: number
		title: string
		body: string
		state: "open" | "closed"
		authorEmail: string
		labels: string[]
		comments: Array<{
			id: string
			authorEmail: string
			body: string
			createdAt: string
			updatedAt?: string
			editedAt?: string
		}>
		createdAt: string
		updatedAt?: string
		editedAt?: string
	}>
	itemNumber?: number
	onCreateIssue: (input: {
		repositoryId: string
		title: string
		body: string
		labels: string[]
	}) => Promise<void>
	onComment: (input: {
		repositoryId: string
		issueNumber: number
		body: string
	}) => Promise<ChatTimelineMessage>
	onEditMessage: (input: {
		repositoryId: string
		issueNumber: number
		messageId: string
		body: string
	}) => Promise<void>
	onEditTitle: (input: {
		repositoryId: string
		issueNumber: number
		title: string
	}) => Promise<void>
	onTransition: (input: {
		repositoryId: string
		issueNumber: number
		nextIssueState: "open" | "closed"
	}) => Promise<void>
	onSignIn: () => Promise<void>
}) {
	const [title, setTitle] = useState("")
	const [body, setBody] = useState("")
	const [labels, setLabels] = useState<string[]>([])
	const [comment, setComment] = useState("")
	const [createBusy, setCreateBusy] = useState(false)
	const [pendingComments, setPendingComments] = useState<PendingComment[]>([])
	const [transitionBusy, setTransitionBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [stateFilter, setStateFilter] = useState<"open" | "closed">("open")
	const navigate = useNavigate()
	const openCount = issues.filter((issue) => issue.state === "open").length
	const closedCount = issues.length - openCount
	const filteredIssues = issues.filter((issue) => issue.state === stateFilter)
	const selected = issues.find((issue) => issue.number === itemNumber)
	const ownerForEmail = (email: string) => displayOwnerName(email, users)
	const maintainerEmails = repository.maintainers.map((maintainer) =>
		maintainer.email.toLowerCase(),
	)
	const triageMaintainerEmails = repository.maintainers
		.filter(
			(maintainer) =>
				maintainer.permissions?.includes("triage") ||
				maintainer.permissions?.includes("settings"),
		)
		.map((maintainer) => maintainer.email.toLowerCase())
	const accessEmails = repository.access.map((grant) =>
		grant.email.toLowerCase(),
	)
	const canEditThreadTitle = (authorEmail: string) =>
		authorEmail.toLowerCase() === actorEmail.toLowerCase() ||
		maintainerEmails.includes(actorEmail.toLowerCase()) ||
		accessEmails.includes(actorEmail.toLowerCase())
	const canTransitionIssue = (authorEmail: string) =>
		repository.policy.issuesEnabled &&
		(triageMaintainerEmails.includes(actorEmail.toLowerCase()) ||
			accessEmails.includes(actorEmail.toLowerCase()) ||
			(repository.policy.allowUserCloseOwnIssues &&
				authorEmail.toLowerCase() === actorEmail.toLowerCase()))
	async function submitIssue(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (!repository.policy.issuesEnabled) return
		if (isAnonymousEmail(actorEmail)) {
			await onSignIn()
			return
		}
		setCreateBusy(true)
		setError(null)
		try {
			await onCreateIssue({ repositoryId: repository.id, title, body, labels })
			setTitle("")
			setBody("")
			setLabels([])
			await navigate({
				to: "/repo/$owner/$repo/issues",
				params: { owner, repo },
			})
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Issue creation failed.",
			)
		} finally {
			setCreateBusy(false)
		}
	}
	async function submitComment(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (isAnonymousEmail(actorEmail)) {
			await onSignIn()
			return
		}
		if (!selected) return
		const body = comment.trim()
		if (!body) return
		const pendingId = `pending:${crypto.randomUUID()}`
		const issueNumber = selected.number
		setPendingComments((current) => [
			...current,
			{
				id: pendingId,
				issueNumber,
				authorEmail: actorEmail,
				body,
				createdAt: new Date().toISOString(),
				persistenceStatus: "sending",
			},
		])
		setComment("")
		setError(null)
		try {
			const stored = await onComment({
				repositoryId: repository.id,
				issueNumber,
				body,
			})
			setPendingComments((current) =>
				current.map((item) =>
					item.id === pendingId
						? { ...stored, issueNumber, persistenceStatus: "stored" }
						: item,
				),
			)
			window.setTimeout(() => {
				setPendingComments((current) =>
					current.filter((item) => item.id !== stored.id),
				)
			}, 1800)
		} catch (cause) {
			setPendingComments((current) =>
				current.map((item) =>
					item.id === pendingId
						? { ...item, persistenceStatus: "failed" }
						: item,
				),
			)
			setError(cause instanceof Error ? cause.message : "Comment failed.")
		}
	}
	if (selected) {
		const canChangeSelectedState = canTransitionIssue(selected.authorEmail)
		const timeline = mergeTimelineMessages([
			{
				id: selected.id,
				authorEmail: selected.authorEmail,
				body: selected.body,
				createdAt: selected.createdAt,
				updatedAt: selected.updatedAt,
				editedAt: selected.editedAt,
			},
			...selected.comments,
			...pendingComments.filter(
				(pending) => pending.issueNumber === selected.number,
			),
		])
		return (
			<section className="min-w-0">
				<article className="min-w-0 space-y-4">
					<header className="rounded-lg border border-base-300 bg-base-100 p-4">
						<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
							<div className="min-w-0">
								<EditableThreadTitle
									actorEmail={actorEmail}
									canEdit={canEditThreadTitle(selected.authorEmail)}
									number={selected.number}
									title={selected.title}
									onEditTitle={(nextTitle) =>
										onEditTitle({
											repositoryId: repository.id,
											issueNumber: selected.number,
											title: nextTitle,
										})
									}
								/>
								<p className="mt-2 break-words text-sm text-base-content/60">
									<span className="badge badge-outline">{selected.state}</span>{" "}
									{ownerForEmail(selected.authorEmail)} opened this issue{" "}
									{new Date(selected.createdAt).toLocaleString()}
								</p>
							</div>
							{isAnonymousEmail(actorEmail) ? (
								<button
									type="button"
									className="btn btn-primary btn-sm shrink-0"
									onClick={() => void onSignIn()}
								>
									Sign in
								</button>
							) : (
								<button
									type="button"
									className="btn btn-outline btn-sm shrink-0"
									disabled={transitionBusy || !canChangeSelectedState}
									onClick={() => {
										setTransitionBusy(true)
										setError(null)
										void onTransition({
											repositoryId: repository.id,
											issueNumber: selected.number,
											nextIssueState:
												selected.state === "open" ? "closed" : "open",
										})
											.catch((cause) =>
												setError(
													cause instanceof Error
														? cause.message
														: "Issue state change failed.",
												),
											)
											.finally(() => setTransitionBusy(false))
									}}
								>
									{transitionBusy
										? "Working"
										: selected.state === "open"
											? "Close issue"
											: "Reopen issue"}
								</button>
							)}
						</div>
					</header>
					<ChatTimeline
						actorEmail={actorEmail}
						messages={timeline}
						ownerForEmail={ownerForEmail}
						users={users}
						onError={(message) => setError(message || null)}
						onEditMessage={(messageId, nextBody) =>
							onEditMessage({
								repositoryId: repository.id,
								issueNumber: selected.number,
								messageId,
								body: nextBody,
							})
						}
					/>
					<div className="card bg-base-100 border border-base-300">
						<div className="card-body p-4 sm:p-6">
							{error ? <div className="alert alert-error">{error}</div> : null}
							<form
								className="space-y-3"
								onSubmit={(event) => void submitComment(event)}
							>
								<textarea
									className="textarea textarea-bordered w-full"
									value={comment}
									onChange={(event) => setComment(event.target.value)}
									required
								/>
								<button
									type="submit"
									className="btn btn-primary btn-sm w-full sm:w-auto"
								>
									Comment
								</button>
							</form>
						</div>
					</div>
				</article>
			</section>
		)
	}

	return (
		<section className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
			<div className="rounded-lg border border-base-300 bg-base-100 overflow-hidden">
				<div className="flex items-center justify-between border-b border-base-300 px-4 py-3">
					<span className="font-semibold">Issues</span>
					<div className="join">
						<button
							type="button"
							className={`join-item btn btn-xs ${stateFilter === "open" ? "btn-active" : "btn-ghost"}`}
							onClick={() => setStateFilter("open")}
						>
							Open ({openCount})
						</button>
						<button
							type="button"
							className={`join-item btn btn-xs ${stateFilter === "closed" ? "btn-active" : "btn-ghost"}`}
							onClick={() => setStateFilter("closed")}
						>
							Closed ({closedCount})
						</button>
					</div>
				</div>
				{filteredIssues.map((issue) => (
					<Link
						key={issue.number}
						to="/repo/$owner/$repo/issues/$number"
						params={{
							owner,
							repo,
							number: String(issue.number),
						}}
						className="block min-w-0 border-b border-base-300 px-4 py-3 hover:bg-base-200"
					>
						<div className="break-words font-semibold">
							#{issue.number} {issue.title}
						</div>
						<div className="break-words text-sm text-base-content/60">
							{issue.state} by {ownerForEmail(issue.authorEmail)}
						</div>
					</Link>
				))}
				{filteredIssues.length === 0 ? (
					<div className="p-8 text-center text-base-content/60">
						No {stateFilter} issues.
					</div>
				) : null}
			</div>
			<form
				className="card bg-base-100 border border-base-300"
				onSubmit={(event) => void submitIssue(event)}
			>
				<div className="card-body gap-3 p-4 sm:p-6">
					<h2 className="card-title">New issue</h2>
					{error ? <div className="alert alert-error">{error}</div> : null}
					{!repository.policy.issuesEnabled ? (
						<div className="alert">
							Issues are disabled for this repository.
						</div>
					) : null}
					<input
						className="input input-bordered w-full"
						placeholder="Title"
						value={title}
						onChange={(event) => setTitle(event.target.value)}
						required
					/>
					<textarea
						className="textarea textarea-bordered w-full"
						placeholder="Body"
						value={body}
						onChange={(event) => setBody(event.target.value)}
						required
					/>
					<div className="flex flex-wrap gap-2">
						{repository.labels.map((label) => (
							<label key={label.id} className="label cursor-pointer gap-2">
								<input
									type="checkbox"
									className="checkbox checkbox-sm"
									checked={labels.includes(label.id)}
									onChange={(event) =>
										setLabels((current) =>
											event.target.checked
												? [...current, label.id]
												: current.filter((id) => id !== label.id),
										)
									}
								/>
								<span>{label.name}</span>
							</label>
						))}
					</div>
					<button
						type="submit"
						className="btn btn-primary w-full sm:w-auto"
						disabled={createBusy || !repository.policy.issuesEnabled}
					>
						{createBusy
							? "Creating"
							: isAnonymousEmail(actorEmail)
								? "Sign in to create issue"
								: "Create issue"}
					</button>
				</div>
			</form>
		</section>
	)
}

function mergeTimelineMessages(messages: ChatTimelineMessage[]) {
	const byId = new Map(messages.map((message) => [message.id, message]))
	return [...byId.values()].sort(
		(left, right) =>
			left.createdAt.localeCompare(right.createdAt) ||
			left.id.localeCompare(right.id),
	)
}
