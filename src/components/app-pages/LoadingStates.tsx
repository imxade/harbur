import { APP_NAME } from "../../lib/app-config"
import type { UploadProgress } from "../../lib/drive-state"

export function DriveLoadingState({
	title = "Loading Drive state",
}: {
	title?: string
}) {
	return (
		<section className="rounded-lg border border-base-300 bg-base-100 p-8 text-center">
			<span className="loading loading-spinner loading-lg text-primary" />
			<h2 className="mt-4 text-lg font-semibold">{title}</h2>
			<p className="mt-2 text-sm text-base-content/60">
				Your {APP_NAME} session is active. Repositories, issues, pull requests,
				and settings are loading from Drive.
			</p>
		</section>
	)
}

export function UploadProgressStatus({
	progress,
	compact = false,
}: {
	progress: UploadProgress | null
	compact?: boolean
}) {
	if (!progress) return null
	return (
		<div className={compact ? "space-y-2" : "space-y-1"}>
			<progress
				className="progress progress-primary w-full"
				value={progress.current}
				max={progress.total}
			/>
			<p
				className={
					compact
						? "text-xs text-base-content/60"
						: "text-sm text-base-content/60"
				}
			>
				{progress.message}
			</p>
		</div>
	)
}
