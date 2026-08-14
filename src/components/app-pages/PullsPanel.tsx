import { Link, useNavigate } from "@tanstack/react-router"
import { Download } from "lucide-react"
import { useState } from "react"
import type { FormEvent } from "react"
import { isAnonymousEmail } from "../../lib/auth"
import { saveDownloadFile, type DownloadFile } from "../../lib/download-client"
import type { ClientPullRequestDiffSnapshot } from "../../lib/client-diff-cache"
import type { PullRequestState } from "../../lib/pulls"
import { displayOwnerName } from "../../lib/users"
import { FileDiffView } from "./FileDiffView"
import { UploadProgressStatus } from "./LoadingStates"
import {
	ChatTimeline,
	EditableThreadTitle,
	type ChatTimelineMessage,
} from "./ThreadComponents"

type PullRequestComment = {
	id: string
	authorEmail: string
	body: string
	createdAt: string
	updatedAt?: string
	editedAt?: string
}

type PullRequestItem = {
	id: string
	number: number
	title: string
	body: string
	state: PullRequestState
	authorEmail: string
	reviewedBy?: string
	createdAt: string
	updatedAt?: string
	editedAt?: string
	comments: PullRequestComment[]
}

type PendingPullRequestCreation = {
	id: string
	title: string
	status: "creating" | "failed"
	error?: string
}

type PendingComment = ChatTimelineMessage & { pullRequestNumber: number }

type UploadProgressView = {
	phase: "preparing" | "zipping" | "uploading"
	current: number
	total: number
	message: string
}

type PullsPanelProps = {
	actorEmail: string
	owner: string
	repo: string
	repositoryId: string
	policy: {
		prsEnabled: boolean
	}
	maintainers: Array<{ email: string; permissions?: string[] }>
	accessGrants: Array<{ email: string }>
	users: Record<string, { ownerName: string }>
	pullRequests: PullRequestItem[]
	pullRequestDiffs: Record<string, ClientPullRequestDiffSnapshot>
	itemNumber?: number
	newPullRequest?: boolean
	onCreatePullRequest: (input: {
		repositoryId: string
		title: string
		body: string
		files: File[]
	}) => Promise<void>
	onComment: (input: {
		repositoryId: string
		pullRequestNumber: number
		body: string
	}) => Promise<ChatTimelineMessage>
	onEditMessage: (input: {
		repositoryId: string
		pullRequestNumber: number
		messageId: string
		body: string
	}) => Promise<void>
	onEditTitle: (input: {
		repositoryId: string
		pullRequestNumber: number
		title: string
	}) => Promise<void>
	onReview: (repositoryId: string, pullRequestNumber: number) => Promise<void>
	onClose: (repositoryId: string, pullRequestNumber: number) => Promise<void>
	onDownloadArchive: (
		repositoryId: string,
		pullRequestNumber: number,
	) => Promise<DownloadFile>
	onMerge: (repositoryId: string, pullRequestNumber: number) => Promise<void>
	onSignIn: () => Promise<void>
	uploadProgress: UploadProgressView | null
}

export function PullsPanel({
	actorEmail,
	owner,
	repo,
	repositoryId,
	policy,
	maintainers,
	accessGrants,
	pullRequests,
	pullRequestDiffs,
	users,
	itemNumber,
	newPullRequest,
	onCreatePullRequest,
	onComment,
	onEditMessage,
	onEditTitle,
	onReview,
	onClose,
	onDownloadArchive,
	onMerge,
	onSignIn,
	uploadProgress,
}: PullsPanelProps) {
	const [title, setTitle] = useState("")
	const [body, setBody] = useState("")
	const [files, setFiles] = useState<File[]>([])
	const [comment, setComment] = useState("")
	const [pendingComments, setPendingComments] = useState<PendingComment[]>([])
	const [actionBusy, setActionBusy] = useState(false)
	const [downloadBusy, setDownloadBusy] = useState(false)
	const [fileInputKey, setFileInputKey] = useState(0)
	const [pendingCreations, setPendingCreations] = useState<
		PendingPullRequestCreation[]
	>([])
	const [error, setError] = useState<string | null>(null)
	const [stateFilter, setStateFilter] = useState<"open" | "closed">("open")
	const navigate = useNavigate()
	const openCount = pullRequests.filter((pr) => pr.state === "open").length
	const closedCount = pullRequests.length - openCount
	const filteredPullRequests = pullRequests.filter((pr) =>
		stateFilter === "open" ? pr.state === "open" : pr.state !== "open",
	)
	const selected = pullRequests.find((pr) => pr.number === itemNumber)
	const selectedDiff = selected ? pullRequestDiffs[selected.id] : undefined
	const ownerForEmail = (email: string) => displayOwnerName(email, users)
	const maintainerEmails = maintainers.map((maintainer) =>
		maintainer.email.toLowerCase(),
	)
	const mergeMaintainerEmails = maintainers
		.filter(
			(maintainer) =>
				maintainer.permissions?.includes("merge") ||
				maintainer.permissions?.includes("settings"),
		)
		.map((maintainer) => maintainer.email.toLowerCase())
	const accessEmails = accessGrants.map((grant) => grant.email.toLowerCase())
	const actorCanMaintain = () =>
		mergeMaintainerEmails.includes(actorEmail.toLowerCase()) ||
		accessEmails.includes(actorEmail.toLowerCase())
	const canEditThreadTitle = (authorEmail: string) =>
		authorEmail.toLowerCase() === actorEmail.toLowerCase() ||
		maintainerEmails.includes(actorEmail.toLowerCase()) ||
		accessEmails.includes(actorEmail.toLowerCase())
	async function submitPullRequest(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (!policy.prsEnabled) return
		if (isAnonymousEmail(actorEmail)) {
			await onSignIn()
			return
		}
		const draft = {
			id: crypto.randomUUID(),
			title,
			body,
			files,
		}
		setPendingCreations((current) => [
			...current,
			{ id: draft.id, title: draft.title, status: "creating" },
		])
		setTitle("")
		setBody("")
		setFiles([])
		setFileInputKey((current) => current + 1)
		setError(null)
		void onCreatePullRequest({
			repositoryId,
			title: draft.title,
			body: draft.body,
			files: draft.files,
		})
			.then(async () => {
				setPendingCreations((current) =>
					current.filter((creation) => creation.id !== draft.id),
				)
				if (newPullRequest) {
					await navigate({
						to: "/repo/$owner/$repo/pulls",
						params: { owner, repo },
					})
				}
			})
			.catch((cause) => {
				const message =
					cause instanceof Error
						? cause.message
						: "Pull request creation failed."
				setPendingCreations((current) =>
					current.map((creation) =>
						creation.id === draft.id
							? { ...creation, status: "failed", error: message }
							: creation,
					),
				)
				setError(message)
			})
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
		const pullRequestNumber = selected.number
		setPendingComments((current) => [
			...current,
			{
				id: pendingId,
				pullRequestNumber,
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
				repositoryId,
				pullRequestNumber,
				body,
			})
			setPendingComments((current) =>
				current.map((item) =>
					item.id === pendingId
						? { ...stored, pullRequestNumber, persistenceStatus: "stored" }
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
	async function downloadArchiveZip() {
		if (!selected) return
		setDownloadBusy(true)
		setError(null)
		try {
			const download = await onDownloadArchive(repositoryId, selected.number)
			saveDownloadFile(download)
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "PR ZIP download failed.",
			)
			setDownloadBusy(false)
		} finally {
			window.setTimeout(() => setDownloadBusy(false), 1500)
		}
	}
	function runPullRequestAction(
		action: () => Promise<void>,
		fallbackMessage: string,
	) {
		setActionBusy(true)
		setError(null)
		void action()
			.catch((cause) =>
				setError(cause instanceof Error ? cause.message : fallbackMessage),
			)
			.finally(() => setActionBusy(false))
	}
	const pullRequestForm = (
		<PullRequestForm
			title={title}
			body={body}
			files={files}
			error={error}
			actorEmail={actorEmail}
			fileInputKey={fileInputKey}
			pendingCreations={pendingCreations}
			prsEnabled={policy.prsEnabled}
			uploadProgress={uploadProgress}
			onTitleChange={setTitle}
			onBodyChange={setBody}
			onFilesChange={setFiles}
			onSubmit={submitPullRequest}
		/>
	)

	if (newPullRequest) {
		return pullRequestForm
	}

	if (selected) {
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
				(pending) => pending.pullRequestNumber === selected.number,
			),
		])
		const archiveLabel =
			selected.state === "merged" ? "Pre-merge ZIP" : "Proposal ZIP"
		return (
			<section className="min-w-0">
				<article className="min-w-0 space-y-4">
					<header className="rounded-lg border border-base-300 bg-base-100 p-4">
						<EditableThreadTitle
							actorEmail={actorEmail}
							canEdit={canEditThreadTitle(selected.authorEmail)}
							number={selected.number}
							title={selected.title}
							onEditTitle={(nextTitle) =>
								onEditTitle({
									repositoryId,
									pullRequestNumber: selected.number,
									title: nextTitle,
								})
							}
						/>
						<p className="mt-2 break-words text-sm text-base-content/60">
							<span className="badge badge-outline">{selected.state}</span>{" "}
							{ownerForEmail(selected.authorEmail)} opened this pull request
						</p>
					</header>
					<ChatTimeline
						actorEmail={actorEmail}
						messages={timeline}
						ownerForEmail={ownerForEmail}
						users={users}
						onError={(message) => setError(message || null)}
						onEditMessage={(messageId, nextBody) =>
							onEditMessage({
								repositoryId,
								pullRequestNumber: selected.number,
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
					<div className="card bg-base-100 border border-base-300">
						<div className="card-body p-4 sm:p-6">
							<div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
								<div className="min-w-0">
									<h3 className="font-semibold">Changed files</h3>
									<p className="mt-1 break-words text-sm text-base-content/60">
										Reviewed by{" "}
										{selected.reviewedBy
											? ownerForEmail(selected.reviewedBy)
											: "nobody"}
									</p>
								</div>
								<div className="flex flex-wrap gap-2">
									{isAnonymousEmail(actorEmail) ? (
										<button
											type="button"
											className="btn btn-primary btn-sm"
											onClick={() => void onSignIn()}
										>
											Sign in
										</button>
									) : null}
									<button
										type="button"
										className="btn btn-outline btn-sm"
										disabled={
											downloadBusy || actionBusy || selected.state === "closed"
										}
										title={
											selected.state === "merged"
												? "Download the repository ZIP from immediately before this merge"
												: "Download the complete proposed repository ZIP for testing"
										}
										onClick={() => void downloadArchiveZip()}
									>
										<Download size={16} />
										{downloadBusy ? "Starting" : archiveLabel}
									</button>
									<button
										type="button"
										className="btn btn-outline btn-sm"
										disabled={
											actionBusy ||
											selected.state !== "open" ||
											isAnonymousEmail(actorEmail) ||
											!actorCanMaintain() ||
											selected.authorEmail.toLowerCase() ===
												actorEmail.toLowerCase()
										}
										onClick={() => {
											runPullRequestAction(
												() => onReview(repositoryId, selected.number),
												"Review failed.",
											)
										}}
									>
										Mark reviewed
									</button>
									<button
										type="button"
										className="btn btn-outline btn-sm"
										disabled={
											actionBusy ||
											selected.state !== "open" ||
											isAnonymousEmail(actorEmail)
										}
										onClick={() => {
											runPullRequestAction(
												() => onClose(repositoryId, selected.number),
												"Close failed.",
											)
										}}
									>
										Close
									</button>
									<button
										type="button"
										className="btn btn-primary btn-sm"
										disabled={
											actionBusy ||
											selected.state !== "open" ||
											!policy.prsEnabled ||
											!actorCanMaintain() ||
											isAnonymousEmail(actorEmail)
										}
										onClick={() => {
											runPullRequestAction(
												() => onMerge(repositoryId, selected.number),
												"Merge failed.",
											)
										}}
									>
										{actionBusy ? "Working" : "Merge"}
									</button>
								</div>
							</div>
							<div className="space-y-3">
								{selectedDiff?.diff.map((fileDiff) => (
									<FileDiffView
										key={`${fileDiff.path}:${fileDiff.status}`}
										diff={fileDiff}
										before={fileDiff.before}
										after={fileDiff.after}
									/>
								))}
								{!selectedDiff ? (
									<div className="alert">Calculating diff in this browser…</div>
								) : null}
							</div>
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
					<span className="font-semibold">Pull requests</span>
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
				{filteredPullRequests.map((pr) => (
					<Link
						key={pr.number}
						to="/repo/$owner/$repo/pulls/$number"
						params={{ owner, repo, number: String(pr.number) }}
						className="block min-w-0 border-b border-base-300 px-4 py-3 hover:bg-base-200"
					>
						<div className="break-words font-semibold">
							#{pr.number} {pr.title}
						</div>
						<div className="break-words text-sm text-base-content/60">
							{pr.state} by {ownerForEmail(pr.authorEmail)}
						</div>
					</Link>
				))}
				{filteredPullRequests.length === 0 ? (
					<div className="p-8 text-center text-base-content/60">
						No {stateFilter} pull requests.
					</div>
				) : null}
			</div>
			{pullRequestForm}
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

function PullRequestForm({
	title,
	body,
	files,
	error,
	actorEmail,
	fileInputKey,
	pendingCreations,
	uploadProgress,
	prsEnabled,
	onTitleChange,
	onBodyChange,
	onFilesChange,
	onSubmit,
}: {
	title: string
	body: string
	files: File[]
	error: string | null
	actorEmail: string
	fileInputKey: number
	pendingCreations: PendingPullRequestCreation[]
	uploadProgress: UploadProgressView | null
	prsEnabled: boolean
	onTitleChange: (value: string) => void
	onBodyChange: (value: string) => void
	onFilesChange: (files: File[]) => void
	onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
	return (
		<form
			className="card bg-base-100 border border-base-300"
			onSubmit={(event) => onSubmit(event)}
		>
			<div className="card-body gap-4 p-4 sm:p-6">
				<h2 className="card-title">New pull request</h2>
				{error ? <div className="alert alert-error">{error}</div> : null}
				{!prsEnabled ? (
					<div className="alert">
						Pull requests are disabled for this repository.
					</div>
				) : null}
				<input
					className="input input-bordered w-full"
					placeholder="Title"
					value={title}
					onChange={(event) => onTitleChange(event.target.value)}
					required
				/>
				<textarea
					className="textarea textarea-bordered w-full"
					placeholder="Body"
					value={body}
					onChange={(event) => onBodyChange(event.target.value)}
					required
				/>
				<input
					key={fileInputKey}
					className="file-input file-input-bordered w-full"
					type="file"
					multiple
					// @ts-expect-error Chromium folder upload attribute.
					webkitdirectory=""
					onChange={(event) =>
						onFilesChange(Array.from(event.currentTarget.files ?? []))
					}
					required
				/>
				<UploadProgressStatus progress={uploadProgress} />
				{pendingCreations.length ? (
					<div className="space-y-2">
						{pendingCreations.map((creation) => (
							<div
								key={creation.id}
								className={`alert py-2 text-sm ${
									creation.status === "failed"
										? "alert-error"
										: "border border-base-300 bg-base-200"
								}`}
							>
								<span className="min-w-0 break-words">
									{creation.status === "failed"
										? `Failed: ${creation.title}`
										: `Creating: ${creation.title}`}
									{creation.error ? ` - ${creation.error}` : ""}
								</span>
							</div>
						))}
					</div>
				) : null}
				<button
					type="submit"
					className="btn btn-primary w-full sm:w-auto"
					disabled={files.length === 0 || !prsEnabled}
				>
					{isAnonymousEmail(actorEmail)
						? "Sign in to open pull request"
						: "Open pull request"}
				</button>
			</div>
		</form>
	)
}
