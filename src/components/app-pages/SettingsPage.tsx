import { HardDrive, Save, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"
import type { FormEvent } from "react"
import { useAppShell } from "../AppShellProvider"
import { APP_DOWNLOAD, APP_NAME } from "../../lib/app-config"
import { driveQuotaUsage, formatDriveBytes } from "../../lib/drive-quota"
import type { AppState } from "../../lib/drive-state"
import type { AppSettings } from "../../lib/types"
import { DriveLoadingState } from "./LoadingStates"

function StorageUsage({ state }: { state: AppState | null }) {
	const { usage, limit, remaining, percent } = driveQuotaUsage(state)
	return (
		<div className="space-y-3">
			<div className="grid gap-3 sm:grid-cols-3">
				<div className="rounded-lg border border-base-300 p-3">
					<div className="text-xs uppercase text-base-content/50">Used</div>
					<div className="mt-1 font-medium">{formatDriveBytes(usage)}</div>
				</div>
				<div className="rounded-lg border border-base-300 p-3">
					<div className="text-xs uppercase text-base-content/50">
						Available
					</div>
					<div className="mt-1 font-medium">{formatDriveBytes(remaining)}</div>
				</div>
				<div className="rounded-lg border border-base-300 p-3">
					<div className="text-xs uppercase text-base-content/50">Limit</div>
					<div className="mt-1 font-medium">{formatDriveBytes(limit)}</div>
				</div>
			</div>
			{percent === null ? null : (
				<progress
					className="progress progress-primary w-full"
					value={percent}
					max={100}
				/>
			)}
		</div>
	)
}

export function SettingsPage() {
	const {
		actor,
		connectBackupDrive,
		connectOwnerDrive,
		deleteBackupDrive,
		disconnectBackupDrive,
		driveState,
		providerStatus,
		signIn,
		updateSettings,
		updateUserName,
	} = useAppShell()
	const settings = driveState?.settings
	const [draft, setDraft] = useState<AppSettings | null>(settings ?? null)
	const currentUserName =
		actor.role === "anonymous"
			? ""
			: (driveState?.users[actor.email.toLowerCase()]?.ownerName ?? "")
	const [profileName, setProfileName] = useState(currentUserName)
	const [settingsBusy, setSettingsBusy] = useState(false)
	const [ownerConnectBusy, setOwnerConnectBusy] = useState(false)
	const [backupConnectBusy, setBackupConnectBusy] = useState(false)
	const [profileBusy, setProfileBusy] = useState(false)
	const [backupBusyId, setBackupBusyId] = useState<string | null>(null)
	const [message, setMessage] = useState<string | null>(null)

	useEffect(() => {
		setDraft(settings ?? null)
	}, [settings])

	useEffect(() => {
		setProfileName(currentUserName)
	}, [currentUserName])

	async function saveProfile(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		setProfileBusy(true)
		setMessage(null)
		try {
			await updateUserName(profileName)
			setMessage("Name saved.")
		} catch (cause) {
			setMessage(cause instanceof Error ? cause.message : "Name save failed.")
		} finally {
			setProfileBusy(false)
		}
	}

	async function saveSettings(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (!draft) return
		setSettingsBusy(true)
		setMessage(null)
		try {
			await updateSettings(draft)
			setMessage("Settings saved.")
		} catch (cause) {
			setMessage(
				cause instanceof Error ? cause.message : "Settings save failed.",
			)
		} finally {
			setSettingsBusy(false)
		}
	}

	function updateDraft(patch: Partial<AppSettings>) {
		if (!draft) return
		setDraft({ ...draft, ...patch })
	}

	function updateDefaultPolicy(
		patch: Partial<AppSettings["defaultRepoPolicy"]>,
	) {
		if (!draft) return
		setDraft({
			...draft,
			defaultRepoPolicy: { ...draft.defaultRepoPolicy, ...patch },
		})
	}

	function backupSyncLabel(target: AppSettings["backupTargets"][number]) {
		if (!target.lastSyncAt) return "Not synced yet"
		const prefix =
			target.lastSyncStatus === "pending" ? "Sync started" : "Last synced"
		return `${prefix} ${new Date(target.lastSyncAt).toLocaleString()}`
	}

	async function connectBackup() {
		setBackupConnectBusy(true)
		setMessage(null)
		try {
			await connectBackupDrive()
			setMessage(
				"Backup Drive connected. Initial sync is running in the background.",
			)
		} catch (cause) {
			setMessage(
				cause instanceof Error
					? cause.message
					: "Backup Drive connection failed.",
			)
		} finally {
			setBackupConnectBusy(false)
		}
	}

	async function connectOwner() {
		setOwnerConnectBusy(true)
		setMessage(null)
		try {
			setMessage(await connectOwnerDrive())
		} catch (cause) {
			setMessage(
				cause instanceof Error
					? cause.message
					: "Owner Drive connection failed.",
			)
		} finally {
			setOwnerConnectBusy(false)
		}
	}

	async function disconnectBackup(targetId: string) {
		setBackupBusyId(targetId)
		setMessage(null)
		try {
			await disconnectBackupDrive(targetId)
			setMessage("Backup Drive disconnected.")
		} catch (cause) {
			setMessage(
				cause instanceof Error
					? cause.message
					: "Backup Drive disconnect failed.",
			)
		} finally {
			setBackupBusyId(null)
		}
	}

	async function deleteBackup(targetId: string) {
		setBackupBusyId(targetId)
		setMessage(null)
		try {
			await deleteBackupDrive(targetId)
			setMessage("Backup Drive data deleted and disconnected.")
		} catch (cause) {
			setMessage(
				cause instanceof Error ? cause.message : "Backup Drive delete failed.",
			)
		} finally {
			setBackupBusyId(null)
		}
	}

	if (providerStatus === "owner-not-configured" && actor.role === "admin") {
		return (
			<main className="max-w-5xl mx-auto p-4 sm:p-6 space-y-6">
				<h1 className="text-2xl font-bold sm:text-3xl">Settings</h1>
				{message ? <section className="alert">{message}</section> : null}
				<section className="card bg-base-100 border border-base-300">
					<div className="card-body gap-4 p-4 sm:p-6">
						<h2 className="card-title">Connect owner Drive</h2>
						<p className="text-sm text-base-content/70">
							Authorize the Google Drive account that will hold Harbur state and
							repository ZIP artifacts. The browser receives only a short-lived
							authorization code; refresh tokens stay server-side.
						</p>
						<div className="card-actions justify-end">
							<button
								type="button"
								className="btn btn-primary w-full sm:w-auto"
								disabled={ownerConnectBusy}
								onClick={() => void connectOwner()}
							>
								{ownerConnectBusy ? "Connecting" : "Connect owner Drive"}
							</button>
						</div>
					</div>
				</section>
			</main>
		)
	}

	if (providerStatus === "loading" && !driveState) {
		return (
			<main className="max-w-5xl mx-auto p-4 sm:p-6">
				<DriveLoadingState title="Loading settings" />
			</main>
		)
	}

	if (providerStatus !== "ready") {
		return (
			<main className="max-w-5xl mx-auto p-4 sm:p-6 space-y-6">
				<h1 className="text-2xl font-bold sm:text-3xl">Settings</h1>
				<section className="alert flex-col items-start sm:flex-row sm:items-center sm:justify-between">
					<span>Sign in with Google to manage {APP_NAME} settings.</span>
					<button
						type="button"
						className="btn btn-primary w-full sm:w-auto"
						onClick={() => void signIn()}
					>
						Sign in with Google
					</button>
				</section>
			</main>
		)
	}

	if (!draft) {
		return (
			<main className="max-w-5xl mx-auto p-4 sm:p-6">
				<DriveLoadingState title="Loading settings" />
			</main>
		)
	}

	return (
		<main className="max-w-5xl mx-auto p-4 sm:p-6 space-y-6">
			<h1 className="text-2xl font-bold sm:text-3xl">Settings</h1>
			{message ? <section className="alert">{message}</section> : null}
			<form
				className="card bg-base-100 border border-base-300"
				onSubmit={(event) => void saveProfile(event)}
			>
				<div className="card-body gap-4 p-4 sm:p-6">
					<h2 className="card-title">Profile</h2>
					<div className="grid divide-y divide-base-300 border-y border-base-300">
						<label className="grid gap-3 py-4 md:grid-cols-[minmax(0,1fr)_minmax(12rem,18rem)] md:items-start">
							<span>
								<span className="block font-medium">Name</span>
								<span className="mt-1 block text-sm text-base-content/60">
									Your unique public handle for repository ownership, comments,
									mentions, and repository URLs. Changing it updates your
									existing repository routes.
								</span>
							</span>
							<input
								className="input input-bordered w-full md:order-2"
								value={profileName}
								onChange={(event) => setProfileName(event.target.value)}
								required
							/>
						</label>
					</div>
					<div className="card-actions justify-end">
						<button
							type="submit"
							className="btn btn-primary w-full sm:w-auto"
							disabled={profileBusy || !profileName.trim()}
						>
							<Save size={16} /> {profileBusy ? "Saving" : "Save Name"}
						</button>
					</div>
				</div>
			</form>
			{actor.role === "admin" ? (
				<section className="card bg-base-100 border border-base-300">
					<div className="card-body gap-3 p-4 sm:p-6">
						<h2 className="card-title">
							<HardDrive size={18} /> Owner Drive storage
						</h2>
						<StorageUsage state={driveState} />
					</div>
				</section>
			) : null}
			{actor.role === "admin" ? (
				<form
					className="card bg-base-100 border border-base-300"
					onSubmit={(event) => void saveSettings(event)}
				>
					<div className="card-body gap-4 p-4 sm:p-6">
						<h2 className="card-title">Admin settings</h2>
						<div className="grid divide-y divide-base-300 border-y border-base-300">
							<label className="grid gap-3 py-4 md:grid-cols-[minmax(0,1fr)_minmax(12rem,18rem)] md:items-start">
								<span>
									<span className="block font-medium">
										Public GitHub mirrors
									</span>
									<span className="mt-1 block text-sm text-base-content/60">
										Allow admins to create repositories from public GitHub
										repository URLs.
									</span>
								</span>
								<input
									className="toggle toggle-primary md:order-2 md:justify-self-end"
									type="checkbox"
									checked={draft.allowPublicGitMirrors}
									onChange={(event) =>
										updateDraft({
											allowPublicGitMirrors: event.target.checked,
										})
									}
								/>
							</label>
							<label className="grid gap-3 py-4 md:grid-cols-[minmax(0,1fr)_minmax(12rem,18rem)] md:items-start">
								<span>
									<span className="block font-medium">
										GitHub mirror interval hours
									</span>
									<span className="mt-1 block text-sm text-base-content/60">
										Refresh mirrored GitHub repositories at most once this many
										hours during admin sessions. Use 0 to disable automatic
										refresh.
									</span>
								</span>
								<input
									className="input input-bordered w-full md:order-2"
									type="number"
									min={0}
									value={draft.githubMirrorSyncIntervalHours}
									onChange={(event) =>
										updateDraft({
											githubMirrorSyncIntervalHours: Number(event.target.value),
										})
									}
								/>
							</label>
							<label className="grid gap-3 py-4 md:grid-cols-[minmax(0,1fr)_minmax(12rem,18rem)] md:items-start">
								<span>
									<span className="block font-medium">
										New repository visibility
									</span>
									<span className="mt-1 block text-sm text-base-content/60">
										Default visibility assigned when an admin creates a
										repository.
									</span>
								</span>
								<select
									className="select select-bordered w-full md:order-2"
									value={draft.defaultRepoVisibility}
									onChange={(event) =>
										updateDraft({
											defaultRepoVisibility: event.target
												.value as AppSettings["defaultRepoVisibility"],
										})
									}
								>
									<option value="public">Public</option>
									<option value="private">Private</option>
								</select>
							</label>
							<label className="grid gap-3 py-4 md:grid-cols-[minmax(0,1fr)_minmax(12rem,18rem)] md:items-start">
								<span>
									<span className="block font-medium">Issues on new repos</span>
									<span className="mt-1 block text-sm text-base-content/60">
										Allow issue creation on repositories created after this
										setting is saved.
									</span>
								</span>
								<input
									className="toggle toggle-primary md:order-2 md:justify-self-end"
									type="checkbox"
									checked={draft.defaultRepoPolicy.issuesEnabled}
									onChange={(event) =>
										updateDefaultPolicy({
											issuesEnabled: event.target.checked,
										})
									}
								/>
							</label>
							<label className="grid gap-3 py-4 md:grid-cols-[minmax(0,1fr)_minmax(12rem,18rem)] md:items-start">
								<span>
									<span className="block font-medium">
										Pull requests on new repos
									</span>
									<span className="mt-1 block text-sm text-base-content/60">
										Allow pull request creation on repositories created after
										this setting is saved.
									</span>
								</span>
								<input
									className="toggle toggle-primary md:order-2 md:justify-self-end"
									type="checkbox"
									checked={draft.defaultRepoPolicy.prsEnabled}
									onChange={(event) =>
										updateDefaultPolicy({
											prsEnabled: event.target.checked,
										})
									}
								/>
							</label>
							<label className="grid gap-3 py-4 md:grid-cols-[minmax(0,1fr)_minmax(12rem,18rem)] md:items-start">
								<span>
									<span className="block font-medium">
										Issue author self-close
									</span>
									<span className="mt-1 block text-sm text-base-content/60">
										Let issue authors close or reopen their own issues on new
										repositories.
									</span>
								</span>
								<input
									className="toggle toggle-primary md:order-2 md:justify-self-end"
									type="checkbox"
									checked={draft.defaultRepoPolicy.allowUserCloseOwnIssues}
									onChange={(event) =>
										updateDefaultPolicy({
											allowUserCloseOwnIssues: event.target.checked,
										})
									}
								/>
							</label>
							<label className="grid gap-3 py-4 md:grid-cols-[minmax(0,1fr)_minmax(12rem,18rem)] md:items-start">
								<span>
									<span className="block font-medium">Merge requirement</span>
									<span className="mt-1 block text-sm text-base-content/60">
										Default pull request review requirement for new
										repositories.
									</span>
								</span>
								<select
									className="select select-bordered w-full md:order-2"
									value={draft.defaultRepoPolicy.requiredStatusForMerge}
									onChange={(event) =>
										updateDefaultPolicy({
											requiredStatusForMerge: event.target
												.value as AppSettings["defaultRepoPolicy"]["requiredStatusForMerge"],
										})
									}
								>
									<option value="none">No review required</option>
									<option value="reviewed">Require maintainer review</option>
								</select>
							</label>
							<label className="grid gap-3 py-4 md:grid-cols-[minmax(0,1fr)_minmax(12rem,18rem)] md:items-start">
								<span>
									<span className="block font-medium">PR auto-clean days</span>
									<span className="mt-1 block text-sm text-base-content/60">
										Delete pull requests older than this many days when a
										repository is loaded. Use 0 to disable auto-clean.
									</span>
								</span>
								<input
									className="input input-bordered w-full md:order-2"
									type="number"
									min={0}
									value={draft.prAutoCleanDays}
									onChange={(event) =>
										updateDraft({
											prAutoCleanDays: Number(event.target.value),
										})
									}
								/>
							</label>
							<label className="grid gap-3 py-4 md:grid-cols-[minmax(0,1fr)_minmax(12rem,18rem)] md:items-start">
								<span>
									<span className="block font-medium">
										Backup interval hours
									</span>
									<span className="mt-1 block text-sm text-base-content/60">
										Run the full backup mirror at most once per connected backup
										Drive in this many hours. Use 0 to disable automatic
										background backups.
									</span>
								</span>
								<input
									className="input input-bordered w-full md:order-2"
									type="number"
									min={0}
									value={draft.backupSyncIntervalHours}
									onChange={(event) =>
										updateDraft({
											backupSyncIntervalHours: Number(event.target.value),
										})
									}
								/>
							</label>
							<label className="grid gap-3 py-4 md:grid-cols-[minmax(0,1fr)_minmax(12rem,18rem)] md:items-start">
								<span>
									<span className="block font-medium">
										Download cleanup delay ms
									</span>
									<span className="mt-1 block text-sm text-base-content/60">
										Wait this long before deleting temporary ZIP download
										copies. Use 0 to clean up as soon as the browser starts the
										media fetch.
									</span>
								</span>
								<input
									className="input input-bordered w-full md:order-2"
									type="number"
									min={0}
									value={
										draft.downloadCleanupDelayMs ?? APP_DOWNLOAD.cleanupDelayMs
									}
									onChange={(event) =>
										updateDraft({
											downloadCleanupDelayMs: Number(event.target.value),
										})
									}
								/>
							</label>
							<label className="grid gap-3 py-4 md:grid-cols-[minmax(0,1fr)_minmax(12rem,18rem)] md:items-start">
								<span>
									<span className="block font-medium">
										Max files per upload
									</span>
									<span className="mt-1 block text-sm text-base-content/60">
										Maximum accepted files when an admin uploads a repository
										folder or a user uploads a pull request folder.
									</span>
								</span>
								<input
									className="input input-bordered w-full md:order-2"
									type="number"
									min={1}
									value={draft.uploadLimits.maxFilesPerUpload}
									onChange={(event) =>
										setDraft({
											...draft,
											uploadLimits: {
												...draft.uploadLimits,
												maxFilesPerUpload: Number(event.target.value),
											},
										})
									}
								/>
							</label>
						</div>
						<div className="card-actions justify-end">
							<button
								type="submit"
								className="btn btn-primary w-full sm:w-auto"
								disabled={settingsBusy}
							>
								<Save size={16} /> {settingsBusy ? "Saving" : "Save settings"}
							</button>
						</div>
					</div>
				</form>
			) : null}
			{actor.role === "admin" ? (
				<section className="card bg-base-100 border border-base-300">
					<div className="card-body gap-4 p-4 sm:p-6">
						<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
							<div>
								<h2 className="card-title">Backup Drives</h2>
								<p className="mt-1 text-sm text-base-content/60">
									Connect Google Drives that store a full restorable mirror of
									the current app state. Refresh tokens are saved only in the
									owner Drive app-data document and are never returned to the
									browser.
								</p>
							</div>
							<button
								type="button"
								className="btn btn-primary w-full sm:w-auto"
								disabled={backupConnectBusy}
								onClick={() => void connectBackup()}
							>
								{backupConnectBusy ? "Connecting" : "Connect backup Drive"}
							</button>
						</div>
						{settings?.backupTargets.length ? (
							<div className="grid gap-3">
								{settings.backupTargets.map((target) => (
									<div
										key={target.id}
										className="rounded-lg border border-base-300 p-4"
									>
										<div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
											<div className="min-w-0">
												<p className="truncate font-medium">
													{target.accountEmail}
												</p>
												<p className="text-sm text-base-content/60">
													{backupSyncLabel(target)}
													{" · "}
													{target.lastSyncStatus ?? "pending"}
												</p>
											</div>
											<div className="grid gap-2 sm:grid-cols-2">
												<button
													type="button"
													className="btn btn-outline"
													disabled={backupBusyId === target.id}
													onClick={() => void disconnectBackup(target.id)}
												>
													Disconnect
												</button>
												<button
													type="button"
													className="btn btn-error"
													disabled={backupBusyId === target.id}
													onClick={() => void deleteBackup(target.id)}
												>
													<Trash2 size={16} /> Delete backup
												</button>
											</div>
										</div>
									</div>
								))}
							</div>
						) : (
							<div className="alert">No backup Drives are connected.</div>
						)}
					</div>
				</section>
			) : null}
		</main>
	)
}
