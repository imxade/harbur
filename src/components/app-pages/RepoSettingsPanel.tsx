import { Archive, Save } from "lucide-react"
import { useState } from "react"
import type { FormEvent } from "react"
import type { RepositoryManifest, RepositoryPolicy } from "../../lib/types"
import { displayOwnerName } from "../../lib/users"

export function RepoSettingsPanel({
	canEdit,
	repository,
	users,
	onUpdate,
}: {
	canEdit: boolean
	repository: RepositoryManifest
	users: Record<string, { ownerName: string }>
	onUpdate: (input: {
		repositoryId: string
		name?: string
		description?: string
		visibility: "public" | "private"
		policy: RepositoryPolicy
		accessEmails: string[]
	}) => Promise<void>
}) {
	const [name, setName] = useState(repository.name)
	const [description, setDescription] = useState(repository.description ?? "")
	const [visibility, setVisibility] = useState(repository.visibility)
	const [policy, setPolicy] = useState(repository.policy)
	const [accessText, setAccessText] = useState(
		(repository.access ?? [])
			.map((grant) => displayOwnerName(grant.email, users))
			.join("\n"),
	)
	const [message, setMessage] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const grants = repository.access ?? []
	const userEntries = Object.entries(users)

	function updatePolicy(patch: Partial<RepositoryPolicy>) {
		setPolicy((current) => ({ ...current, ...patch }))
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		setBusy(true)
		setMessage(null)
		try {
			const accessEmails = resolveAccessEntries(accessText, users)
			await onUpdate({
				repositoryId: repository.id,
				name: name.trim(),
				description: description.trim(),
				visibility,
				policy,
				accessEmails,
			})
			setMessage("Repository settings saved.")
		} catch (cause) {
			setMessage(
				cause instanceof Error ? cause.message : "Repository access failed.",
			)
		} finally {
			setBusy(false)
		}
	}

	return (
		<form
			className="card bg-base-100 border border-base-300"
			onSubmit={(event) => void submit(event)}
		>
			<div className="card-body gap-4 p-4 sm:p-6">
				<h2 className="card-title">
					<Archive size={18} /> Repository settings
				</h2>
				{message ? <div className="alert">{message}</div> : null}
				{!canEdit ? (
					<div className="alert alert-warning">
						Only the repository owner can change repository settings.
					</div>
				) : null}
				<label className="grid gap-3 py-4 md:grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)] md:items-start">
					<span>
						<span className="block font-medium">Repository name</span>
						<span className="mt-1 block text-sm text-base-content/60">
							Changing this updates the repository route. Use letters, numbers,
							dots, underscores, and hyphens.
						</span>
					</span>
					<input
						className="input input-bordered w-full"
						value={name}
						disabled={!canEdit}
						title="Use letters, numbers, dots, underscores, and hyphens. Start with a letter or number."
						onChange={(event) => setName(event.target.value)}
						required
					/>
				</label>
				<div className="grid divide-y divide-base-300 border-y border-base-300">
					<label className="grid gap-3 py-4 md:grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)] md:items-start">
						<span>
							<span className="block font-medium">Issues</span>
							<span className="mt-1 block text-sm text-base-content/60">
								Allow signed-in users who can see this repository to open
								issues.
							</span>
						</span>
						<input
							className="toggle toggle-primary justify-self-start"
							type="checkbox"
							checked={policy.issuesEnabled}
							disabled={!canEdit}
							onChange={(event) =>
								updatePolicy({ issuesEnabled: event.target.checked })
							}
						/>
					</label>
					<label className="grid gap-3 py-4 md:grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)] md:items-start">
						<span>
							<span className="block font-medium">Pull requests</span>
							<span className="mt-1 block text-sm text-base-content/60">
								Allow signed-in users who can see this repository to open pull
								requests.
							</span>
						</span>
						<input
							className="toggle toggle-primary justify-self-start"
							type="checkbox"
							checked={policy.prsEnabled}
							disabled={!canEdit}
							onChange={(event) =>
								updatePolicy({ prsEnabled: event.target.checked })
							}
						/>
					</label>
					<label className="grid gap-3 py-4 md:grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)] md:items-start">
						<span>
							<span className="block font-medium">Issue author self-close</span>
							<span className="mt-1 block text-sm text-base-content/60">
								Let issue authors close or reopen their own issues.
							</span>
						</span>
						<input
							className="toggle toggle-primary justify-self-start"
							type="checkbox"
							checked={policy.allowUserCloseOwnIssues}
							disabled={!canEdit || !policy.issuesEnabled}
							onChange={(event) =>
								updatePolicy({
									allowUserCloseOwnIssues: event.target.checked,
								})
							}
						/>
					</label>
					<label className="grid gap-3 py-4 md:grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)] md:items-start">
						<span>
							<span className="block font-medium">Merge requirement</span>
							<span className="mt-1 block text-sm text-base-content/60">
								Choose whether PRs need a maintainer review before merge.
							</span>
						</span>
						<select
							className="select select-bordered w-full"
							value={policy.requiredStatusForMerge}
							disabled={!canEdit || !policy.prsEnabled}
							onChange={(event) =>
								updatePolicy({
									requiredStatusForMerge: event.target
										.value as RepositoryPolicy["requiredStatusForMerge"],
								})
							}
						>
							<option value="none">No review required</option>
							<option value="reviewed">Require maintainer review</option>
						</select>
					</label>
				</div>
				<label className="grid gap-3 py-4 md:grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)] md:items-start">
					<span>
						<span className="block font-medium">Description</span>
						<span className="mt-1 block text-sm text-base-content/60">
							Shown on the repository header and repository cards.
						</span>
					</span>
					<textarea
						className="textarea textarea-bordered min-h-24 w-full"
						value={description}
						disabled={!canEdit}
						onChange={(event) => setDescription(event.target.value)}
					/>
				</label>
				<label className="grid gap-3 py-4 md:grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)] md:items-start">
					<span>
						<span className="block font-medium">Visibility</span>
						<span className="mt-1 block text-sm text-base-content/60">
							Public repositories are visible without signing in. Private
							repositories are visible only to admins and granted users.
						</span>
					</span>
					<select
						className="select select-bordered w-full"
						value={visibility}
						disabled={!canEdit}
						onChange={(event) =>
							setVisibility(event.target.value as "public" | "private")
						}
					>
						<option value="public">Public</option>
						<option value="private">Private</option>
					</select>
				</label>
				<label className="grid gap-3 py-4 md:grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)] md:items-start">
					<span>
						<span className="block font-medium">Private access</span>
						<span className="mt-1 block text-sm text-base-content/60">
							Enter one registered email or Name per line. Grants can view
							private repositories, edit issue and pull request titles, close or
							reopen threads, and merge pull requests.
						</span>
					</span>
					<textarea
						className="textarea textarea-bordered min-h-32 w-full"
						value={accessText}
						disabled={!canEdit}
						onChange={(event) => setAccessText(event.target.value)}
					/>
				</label>
				{grants.length ? (
					<div className="rounded-lg border border-base-300 bg-base-200/40 p-4">
						<h3 className="font-semibold">Current private grants</h3>
						<div className="mt-3 flex flex-wrap gap-2">
							{grants.map((grant) => (
								<span key={grant.email} className="badge badge-outline">
									{displayOwnerName(grant.email, users)}
								</span>
							))}
						</div>
					</div>
				) : null}
				{userEntries.length ? (
					<div className="rounded-lg border border-base-300 bg-base-200/40 p-4">
						<h3 className="font-semibold">Registered users</h3>
						<div className="mt-3 grid gap-2 sm:grid-cols-2">
							{userEntries.map(([email, user]) => (
								<div key={email} className="min-w-0 text-sm">
									<span className="font-medium">{user.ownerName}</span>
								</div>
							))}
						</div>
					</div>
				) : null}
				<div className="card-actions justify-end">
					<button
						type="submit"
						className="btn btn-primary w-full sm:w-auto"
						disabled={!canEdit || busy}
					>
						<Save size={16} /> {busy ? "Saving" : "Save settings"}
					</button>
				</div>
			</div>
		</form>
	)
}

function resolveAccessEntries(
	value: string,
	users: Record<string, { ownerName: string }>,
) {
	const usersByName = new Map(
		Object.entries(users).map(([email, user]) => [
			user.ownerName.toLowerCase(),
			email,
		]),
	)
	return [
		...new Set(
			value
				.split(/\n|,/)
				.map((entry) => entry.trim())
				.filter(Boolean)
				.map((entry) => {
					if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry)) {
						const email = entry.toLowerCase()
						if (!users[email])
							throw new Error(`User is not registered: ${entry}`)
						return email
					}
					const email = usersByName.get(entry.toLowerCase())
					if (!email) throw new Error(`Unknown user name: ${entry}`)
					return email
				}),
		),
	]
}
