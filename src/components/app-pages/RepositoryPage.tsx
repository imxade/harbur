import { Link } from "@tanstack/react-router"
import { Download, Github, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"
import { useAppShell } from "../AppShellProvider"
import { saveDownloadFile } from "../../lib/download-client"
import { LinkifiedText } from "../LinkifiedText"
import { DriveLoadingState } from "./LoadingStates"
import { IssuesPanel } from "./IssuesPanel"
import { OverviewPanel } from "./OverviewPanel"
import { PullsPanel } from "./PullsPanel"
import { RepoSettingsPanel } from "./RepoSettingsPanel"

export function RepositoryPage({
	owner,
	repo,
	view = "overview",
	itemNumber,
	newPullRequest = false,
}: {
	owner: string
	repo: string
	view?: "overview" | "issues" | "pulls" | "settings"
	itemNumber?: number
	newPullRequest?: boolean
}) {
	const {
		actor,
		closePullRequest,
		commentOnIssue,
		commentOnPullRequest,
		createIssue,
		createPullRequest,
		deleteRepository,
		downloadPullRequestPreviewZip,
		downloadRepositoryZip,
		driveState,
		editIssueMessage,
		editIssueTitle,
		editPullRequestMessage,
		editPullRequestTitle,
		loadRepositoryDetail,
		mergePullRequest,
		providerStatus,
		reviewPullRequest,
		signIn,
		transitionIssue,
		updateRepositoryAccess,
		uploadProgress,
		watchRepository,
	} = useAppShell()
	const [deleting, setDeleting] = useState(false)
	const [downloadBusy, setDownloadBusy] = useState(false)
	const [loadingRepositoryId, setLoadingRepositoryId] = useState<string | null>(
		null,
	)
	const [repositoryDetailError, setRepositoryDetailError] = useState<
		string | null
	>(null)
	const manifest = driveState?.repositories.find(
		(repository) => repository.owner === owner && repository.name === repo,
	)
	const repositoryDetailsLoaded = Boolean(
		manifest && driveState?.loadedRepositoryIds?.includes(manifest.id),
	)
	const repositoryReadmeLoaded =
		view !== "overview" ||
		Boolean(
			manifest && driveState?.loadedRepositoryReadmeIds?.includes(manifest.id),
		)
	const selectedPullRequest =
		manifest && typeof itemNumber === "number"
			? driveState?.pullRequests[manifest.id]?.find(
					(pullRequest) => pullRequest.number === itemNumber,
				)
			: undefined
	const selectedIssue =
		manifest && typeof itemNumber === "number"
			? driveState?.issues[manifest.id]?.find(
					(issue) => issue.number === itemNumber,
				)
			: undefined
	const selectedIssueThreadLoaded =
		view !== "issues" ||
		typeof itemNumber !== "number" ||
		!repositoryDetailsLoaded ||
		!selectedIssue ||
		Boolean(driveState?.loadedThreadIds?.includes(selectedIssue.id))
	const selectedPullRequestThreadLoaded =
		view !== "pulls" ||
		typeof itemNumber !== "number" ||
		!repositoryDetailsLoaded ||
		!selectedPullRequest ||
		Boolean(driveState?.loadedThreadIds?.includes(selectedPullRequest.id))
	const selectedPullRequestFilesLoaded =
		view !== "pulls" ||
		typeof itemNumber !== "number" ||
		!repositoryDetailsLoaded ||
		!selectedPullRequest ||
		selectedPullRequest.files.length > 0 ||
		Boolean(
			driveState?.loadedPullRequestFileIds?.includes(selectedPullRequest.id),
		)
	const repositoryReady =
		repositoryDetailsLoaded &&
		repositoryReadmeLoaded &&
		selectedIssueThreadLoaded &&
		selectedPullRequestThreadLoaded
	const watched = Boolean(
		actor.email &&
			driveState?.watches[actor.email]?.includes(manifest?.id ?? ""),
	)
	const canOwnRepository = Boolean(
		manifest?.maintainers.some(
			(maintainer) =>
				maintainer.email.toLowerCase() === actor.email.toLowerCase() &&
				maintainer.permissions.includes("settings"),
		),
	)
	async function submitDelete() {
		if (!manifest) return
		if (
			!window.confirm(`Delete ${manifest.owner}/${manifest.name} from Drive?`)
		) {
			return
		}
		setDeleting(true)
		try {
			await deleteRepository(manifest.id)
			window.location.assign("/")
		} finally {
			setDeleting(false)
		}
	}
	async function submitZipDownload() {
		if (!manifest || downloadBusy) return
		setDownloadBusy(true)
		try {
			const download = await downloadRepositoryZip(manifest.id)
			saveDownloadFile(download)
			window.setTimeout(() => setDownloadBusy(false), 1500)
		} catch (cause) {
			setDownloadBusy(false)
			throw cause
		}
	}

	useEffect(() => {
		if (!manifest || (repositoryReady && selectedPullRequestFilesLoaded)) {
			return
		}
		if (loadingRepositoryId === manifest.id) return
		if (repositoryDetailError) return
		let active = true
		setLoadingRepositoryId(manifest.id)
		setRepositoryDetailError(null)
		void loadRepositoryDetail(manifest.id, {
			issueNumber:
				view === "issues" && typeof itemNumber === "number"
					? itemNumber
					: undefined,
			pullRequestNumber:
				view === "pulls" && typeof itemNumber === "number"
					? itemNumber
					: undefined,
		})
			.catch((cause) => {
				if (!active) return
				setRepositoryDetailError(
					cause instanceof Error
						? cause.message
						: "Repository detail load failed.",
				)
			})
			.finally(() => {
				if (active) setLoadingRepositoryId(null)
			})
		return () => {
			active = false
		}
	}, [
		itemNumber,
		loadRepositoryDetail,
		loadingRepositoryId,
		manifest,
		repositoryDetailError,
		repositoryReady,
		selectedPullRequestFilesLoaded,
		view,
	])

	if (providerStatus === "loading" && !driveState) {
		return (
			<main className="max-w-4xl mx-auto p-4 sm:p-6">
				<DriveLoadingState title="Loading repository" />
			</main>
		)
	}
	if (!manifest) {
		if (!driveState) {
			return (
				<main className="max-w-4xl mx-auto p-4 sm:p-6">
					<section className="alert">
						<span>Loading repository state from Drive.</span>
					</section>
				</main>
			)
		}
		return (
			<main className="max-w-4xl mx-auto p-4 sm:p-6">
				<section className="alert flex-col items-start sm:flex-row sm:items-center sm:justify-between">
					<span>Repository not found or private.</span>
					{actor.role === "anonymous" ? (
						<button
							type="button"
							className="btn btn-primary w-full sm:w-auto"
							onClick={() => void signIn()}
						>
							Sign in with Google
						</button>
					) : null}
				</section>
			</main>
		)
	}
	const currentDriveState = driveState as NonNullable<typeof driveState>
	if (!repositoryReady) {
		return (
			<main className="max-w-4xl mx-auto p-4 sm:p-6">
				{repositoryDetailError ? (
					<section className="alert alert-error">
						<span>{repositoryDetailError}</span>
					</section>
				) : (
					<DriveLoadingState
						title={
							loadingRepositoryId === manifest.id
								? "Loading repository detail"
								: "Loading repository"
						}
					/>
				)}
			</main>
		)
	}
	const issueCount = (currentDriveState.issues[manifest.id] ?? []).filter(
		(issue) => issue.state === "open",
	).length
	const pullRequestCount = (
		currentDriveState.pullRequests[manifest.id] ?? []
	).filter((pullRequest) => pullRequest.state === "open").length
	return (
		<main className="max-w-7xl mx-auto p-4 sm:p-6 space-y-6">
			<section className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
				<div className="min-w-0">
					<p className="text-sm text-base-content/60">Public repository</p>
					<h1 className="break-all text-2xl font-bold sm:text-3xl">
						{owner}/{repo}
					</h1>
					<p className="mt-2 break-words text-base-content/70">
						<LinkifiedText
							text={
								manifest.description ??
								"Drive-backed snapshot with portable repository metadata."
							}
						/>
					</p>
				</div>
				<div className="flex flex-wrap gap-2 sm:justify-end">
					<button
						type="button"
						className={
							watched ? "btn btn-secondary btn-sm" : "btn btn-outline btn-sm"
						}
						onClick={() =>
							actor.role === "anonymous"
								? void signIn()
								: manifest
									? void watchRepository(manifest.id, !watched)
									: undefined
						}
					>
						{watched ? "Watching" : "Watch"}
					</button>
					<button
						type="button"
						className="btn btn-outline btn-sm"
						disabled={downloadBusy}
						onClick={() => void submitZipDownload()}
					>
						<Download size={16} /> {downloadBusy ? "Starting" : "ZIP"}
					</button>
					{manifest.githubMirror ? (
						<a
							href={manifest.githubMirror.htmlUrl}
							target="_blank"
							rel="noreferrer"
							className="btn btn-outline btn-sm"
						>
							<Github size={16} /> GitHub
						</a>
					) : null}
					{actor.role === "admin" ? (
						<button
							type="button"
							className="btn btn-error btn-sm"
							disabled={deleting}
							onClick={() => void submitDelete()}
						>
							<Trash2 size={16} /> {deleting ? "Deleting" : "Delete"}
						</button>
					) : null}
				</div>
			</section>
			<div className="overflow-x-auto">
				<div className="tabs tabs-boxed w-max">
					<Link
						to="/repo/$owner/$repo"
						params={{ owner, repo }}
						className={view === "overview" ? "tab tab-active" : "tab"}
					>
						Overview
					</Link>
					<Link
						to="/repo/$owner/$repo/issues"
						params={{ owner, repo }}
						className={view === "issues" ? "tab tab-active" : "tab"}
					>
						Issues <span className="badge badge-sm">{issueCount}</span>
					</Link>
					<Link
						to="/repo/$owner/$repo/pulls"
						params={{ owner, repo }}
						className={view === "pulls" ? "tab tab-active" : "tab"}
					>
						Pulls <span className="badge badge-sm">{pullRequestCount}</span>
					</Link>
					{canOwnRepository ? (
						<Link
							to="/repo/$owner/$repo/settings"
							params={{ owner, repo }}
							className={view === "settings" ? "tab tab-active" : "tab"}
						>
							Settings
						</Link>
					) : null}
				</div>
			</div>
			{view === "issues" ? (
				<IssuesPanel
					actorEmail={actor.email}
					owner={owner}
					repo={repo}
					repository={manifest}
					issues={currentDriveState.issues[manifest.id] ?? []}
					users={currentDriveState.users}
					itemNumber={itemNumber}
					onCreateIssue={createIssue}
					onComment={commentOnIssue}
					onEditMessage={editIssueMessage}
					onEditTitle={editIssueTitle}
					onTransition={transitionIssue}
					onSignIn={signIn}
				/>
			) : null}
			{view === "pulls" ? (
				<PullsPanel
					actorEmail={actor.email}
					owner={owner}
					repo={repo}
					repositoryId={manifest.id}
					policy={manifest.policy}
					maintainers={manifest.maintainers}
					accessGrants={manifest.access ?? []}
					baseFiles={currentDriveState.repositoryFiles[manifest.id] ?? []}
					pullRequests={currentDriveState.pullRequests[manifest.id] ?? []}
					users={currentDriveState.users}
					itemNumber={itemNumber}
					newPullRequest={newPullRequest}
					onCreatePullRequest={createPullRequest}
					onComment={commentOnPullRequest}
					onEditMessage={editPullRequestMessage}
					onEditTitle={editPullRequestTitle}
					onReview={reviewPullRequest}
					onClose={closePullRequest}
					onDownloadMerged={downloadPullRequestPreviewZip}
					onMerge={mergePullRequest}
					onSignIn={signIn}
					uploadProgress={uploadProgress}
				/>
			) : null}
			{view === "settings" ? (
				<RepoSettingsPanel
					canEdit={canOwnRepository}
					repository={manifest}
					users={currentDriveState.users}
					onUpdate={async (input) => {
						await updateRepositoryAccess(input)
						if (input.name && input.name !== manifest.name) {
							window.location.assign(
								`/repo/${manifest.owner}/${input.name}/settings`,
							)
						}
					}}
				/>
			) : null}
			{view === "overview" ? (
				<OverviewPanel
					files={currentDriveState.repositoryReadmeFiles[manifest.id] ?? []}
				/>
			) : null}
		</main>
	)
}
