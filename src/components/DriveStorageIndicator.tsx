import { HardDrive } from "lucide-react"
import { driveQuotaUsage, formatDriveBytes } from "../lib/drive-quota"
import type { AppState } from "../lib/drive-state"

export default function DriveStorageIndicator({
	state,
}: {
	state: AppState | null
}) {
	if (!state?.driveStorageQuota) return null
	const quota = driveQuotaUsage(state)
	const label =
		quota.usage === null || quota.limit === null
			? "Drive usage unavailable"
			: `${formatDriveBytes(quota.usage)} of ${formatDriveBytes(quota.limit)} used`

	return (
		<div
			className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-base-300 px-1.5 text-xs text-base-content/70 sm:px-2"
			title={label}
		>
			<HardDrive size={16} />
			<span>{quota.percent === null ? "Drive" : `${quota.percent}%`}</span>
		</div>
	)
}
