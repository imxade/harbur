import { Link, createFileRoute } from "@tanstack/react-router"
import { useId, useRef, useState } from "react"
import { z } from "zod"
import { useAppShell } from "../components/AppShellProvider"
import {
	DriveLoadingState,
	UploadProgressStatus,
} from "../components/app-pages/LoadingStates"
import Icon from "../components/Icon"
import RepositoryCard from "../components/RepositoryCard"
import {
	groupRepositoriesByOwner,
	inferRepositoryNameFromGitHubUrl,
	rankRepositoriesByQuery,
	toRepositorySummary,
} from "../lib/search"
import { APP_UPLOAD } from "../lib/app-config"
import { driveQuotaUsage, formatDriveBytes } from "../lib/drive-quota"
import { summarizeClientUploadFiles } from "../lib/upload-client"

const searchSchema = z.object({
	q: z.string().optional().catch(""),
})

export const Route = createFileRoute("/")({
	validateSearch: (search) => searchSchema.parse(search),
	component: HomePage,
})

function HomePage() {
	const formId = useId()
	const { q: query = "" } = Route.useSearch()
	const navigate = Route.useNavigate()
	const {
		actor,
		createRepository,
		driveState,
		error,
		providerStatus,
		uploadProgress,
	} = useAppShell()
	const [name, setName] = useState("")
	const [description, setDescription] = useState("")
	const [githubUrl, setGithubUrl] = useState("")
	const [files, setFiles] = useState<File[]>([])
	const [acceptedFileCount, setAcceptedFileCount] = useState(0)
	const [acceptedFileBytes, setAcceptedFileBytes] = useState(0)
	const [busy, setBusy] = useState(false)
	const [formError, setFormError] = useState<string | null>(null)
	const fileSelectionVersion = useRef(0)
	const fileInputRef = useRef<HTMLInputElement | null>(null)
	const allRepositories =
		driveState?.repositories.map(toRepositorySummary) ?? []
	const filteredRepositories = rankRepositoriesByQuery(allRepositories, query)
	const ownerGroups = groupRepositoriesByOwner(allRepositories)
	const nameId = `${formId}-repository-name`
	const descriptionId = `${formId}-repository-description`
	const githubUrlId = `${formId}-github-url`
	const folderId = `${formId}-codebase-folder`
	const quota = driveQuotaUsage(driveState)
	const localUploadBytesWithMargin =
		acceptedFileBytes + APP_UPLOAD.driveQuotaSafetyBytes
	const localUploadExceedsQuota =
		!githubUrl.trim() &&
		acceptedFileBytes > 0 &&
		quota.remaining !== null &&
		localUploadBytesWithMargin > quota.remaining

	function updateQuery(value: string) {
		void navigate({
			search: value.trim() ? { q: value } : {},
			replace: true,
		})
	}

	async function submitRepository(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault()
		setBusy(true)
		setFormError(null)
		try {
			const trimmedGitHubUrl = githubUrl.trim()
			const repositoryName =
				name.trim() ||
				(trimmedGitHubUrl
					? inferRepositoryNameFromGitHubUrl(trimmedGitHubUrl)
					: "")
			if (!repositoryName) {
				throw new Error("Enter a repository name or GitHub repository URL.")
			}
			if (!trimmedGitHubUrl && files.length === 0) {
				throw new Error("Choose a codebase folder or enter a GitHub URL.")
			}
			await createRepository({
				name: repositoryName,
				description,
				files,
				githubUrl: trimmedGitHubUrl || undefined,
			})
			setName("")
			setDescription("")
			setGithubUrl("")
			setFiles([])
			setAcceptedFileCount(0)
			setAcceptedFileBytes(0)
			if (fileInputRef.current) fileInputRef.current.value = ""
		} catch (cause) {
			setFormError(
				cause instanceof Error ? cause.message : "Repository upload failed.",
			)
		} finally {
			setBusy(false)
		}
	}

	async function updateSelectedFiles(nextFiles: File[]) {
		const version = fileSelectionVersion.current + 1
		fileSelectionVersion.current = version
		setFiles(nextFiles)
		setAcceptedFileCount(0)
		setAcceptedFileBytes(0)
		setFormError(null)
		if (!nextFiles.length) return
		try {
			const summary = await summarizeClientUploadFiles(nextFiles)
			if (fileSelectionVersion.current === version) {
				setAcceptedFileCount(summary.accepted)
				setAcceptedFileBytes(summary.acceptedBytes)
			}
		} catch (cause) {
			if (fileSelectionVersion.current !== version) return
			setFormError(
				cause instanceof Error ? cause.message : "Could not inspect upload.",
			)
		}
	}

	return (
		<main className="max-w-6xl mx-auto px-4 pb-12 pt-6 sm:pt-8">
			{error || formError ? (
				<div className="alert alert-error mb-8">{error ?? formError}</div>
			) : null}

			{(providerStatus === "loading" || providerStatus === "ready") &&
			!driveState ? (
				<div className="mb-8">
					<DriveLoadingState title="Loading repositories" />
				</div>
			) : null}

			{providerStatus === "owner-not-configured" ? (
				<section className="alert mb-8">
					<span>
						Owner Drive is not connected yet. Open settings as an admin to
						authorize server-side Drive storage.
					</span>
				</section>
			) : null}

			{actor.role === "admin" && driveState ? (
				<form
					className="card mb-8 bg-base-100 border border-base-300"
					onSubmit={(event) => void submitRepository(event)}
				>
					<div className="card-body gap-4 p-4 sm:p-6">
						<h2 className="card-title">Create repository</h2>
						<div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
							<div className="grid gap-2">
								<label className="font-medium" htmlFor={nameId}>
									Repository name
								</label>
								<input
									id={nameId}
									className="input input-bordered w-full"
									value={name}
									onChange={(event) => setName(event.target.value)}
									placeholder="Inferred for GitHub mirrors"
									title="Use letters, numbers, dots, underscores, and hyphens. Start with a letter or number."
								/>
							</div>
							<div className="grid gap-2">
								<label className="font-medium" htmlFor={descriptionId}>
									Description
								</label>
								<input
									id={descriptionId}
									className="input input-bordered w-full"
									value={description}
									onChange={(event) => setDescription(event.target.value)}
								/>
							</div>
						</div>
						<div className="grid gap-2">
							<label className="font-medium" htmlFor={githubUrlId}>
								Public GitHub repository
							</label>
							<input
								id={githubUrlId}
								className="input input-bordered w-full"
								type="url"
								value={githubUrl}
								onChange={(event) => setGithubUrl(event.target.value)}
								placeholder="https://github.com/owner/repo"
							/>
							<p className="text-sm text-base-content/60">
								Use a public GitHub URL or upload a folder below.
							</p>
						</div>
						<div className="grid gap-2">
							<label className="font-medium" htmlFor={folderId}>
								Codebase folder
							</label>
							<input
								id={folderId}
								ref={fileInputRef}
								className="file-input file-input-bordered w-full"
								type="file"
								multiple
								// @ts-expect-error Chromium folder upload attribute.
								webkitdirectory=""
								onChange={(event) =>
									void updateSelectedFiles(
										Array.from(event.currentTarget.files ?? []),
									)
								}
							/>
							<p className="text-sm text-base-content/60">
								Ignored when a GitHub URL is provided.
							</p>
							{acceptedFileBytes > 0 && !githubUrl.trim() ? (
								<p
									className={
										localUploadExceedsQuota
											? "text-sm text-error"
											: "text-sm text-base-content/60"
									}
								>
									Selected folder: {formatDriveBytes(acceptedFileBytes)}. Upload
									requires {formatDriveBytes(localUploadBytesWithMargin)} with
									safety margin.
								</p>
							) : null}
						</div>
						<UploadProgressStatus progress={uploadProgress} />
						<div className="card-actions justify-end">
							<button
								type="submit"
								className="btn btn-primary w-full sm:w-auto"
								disabled={
									busy ||
									localUploadExceedsQuota ||
									(!githubUrl.trim() && acceptedFileCount === 0)
								}
							>
								{busy
									? "Creating"
									: githubUrl.trim()
										? "Create GitHub mirror"
										: `Upload ${acceptedFileCount} files`}
							</button>
						</div>
					</div>
				</form>
			) : null}

			{driveState ? (
				<label className="grid gap-2 mb-8">
					<input
						className="input input-bordered w-full"
						value={query}
						onChange={(event) => updateQuery(event.target.value)}
						placeholder="Search owners, repositories, or descriptions"
					/>
				</label>
			) : null}

			{driveState && filteredRepositories !== null ? (
				filteredRepositories.length === 0 ? (
					<div className="text-center py-12 text-base-content/30 flex flex-col items-center">
						<Icon name="search" size={64} strokeWidth={1} className="mb-4" />
						<p className="break-words text-lg">
							No repositories found for "{query}"
						</p>
					</div>
				) : (
					<section className="mb-10">
						<h2 className="text-xl font-bold text-base-content mb-4">
							{filteredRepositories.length} result
							{filteredRepositories.length !== 1 ? "s" : ""}
						</h2>
						<div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
							{filteredRepositories.map((repository) => (
								<RepositoryCard key={repository.id} repository={repository} />
							))}
						</div>
					</section>
				)
			) : driveState ? (
				<section className="mb-10">
					<h2 className="text-xl font-bold text-base-content mb-4 flex items-center gap-2">
						Owners
					</h2>
					{allRepositories.length === 0 ? (
						<div className="rounded-lg border border-base-300 bg-base-100 p-8 text-center text-base-content/60">
							No repositories have been published yet.
						</div>
					) : (
						<div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
							{ownerGroups.map((group) => (
								<Link
									key={group.owner}
									to="/$owner"
									params={{ owner: group.owner }}
									className="card h-full bg-base-100 border border-base-300 shadow-sm transition-colors hover:border-primary hover:bg-base-200 focus:outline-none focus:ring-2 focus:ring-primary"
									aria-label={`Show repositories owned by ${group.owner}`}
								>
									<div className="card-body gap-3 p-4 sm:p-6">
										<div className="min-w-0">
											<p className="text-xs uppercase tracking-wide text-base-content/50">
												Owner
											</p>
											<h3 className="card-title break-all text-lg">
												{group.owner}
											</h3>
										</div>
										<p className="text-sm text-base-content/70">
											{group.repositories.length} repositor
											{group.repositories.length === 1 ? "y" : "ies"}
										</p>
										<p className="text-xs text-base-content/50">
											Updated {new Date(group.updatedAt).toLocaleString()}
										</p>
									</div>
								</Link>
							))}
						</div>
					)}
				</section>
			) : null}
		</main>
	)
}
