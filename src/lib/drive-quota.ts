import type { AppState } from "./drive-state"
import { APP_UPLOAD } from "./app-config"

export function driveQuotaBytes(value: string | undefined) {
	if (!value) return null
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : null
}

export function driveQuotaUsage(state: AppState | null) {
	const quota = state?.driveStorageQuota
	const usage = driveQuotaBytes(quota?.usage)
	const limit = driveQuotaBytes(quota?.limit)
	const remaining =
		usage === null || limit === null ? null : Math.max(0, limit - usage)
	const percent =
		usage === null || limit === null || limit === 0
			? null
			: Math.min(100, Math.round((usage / limit) * 100))
	return { usage, limit, remaining, percent }
}

export function formatDriveBytes(bytes: number | null) {
	if (bytes === null) return "Unknown"
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
	if (bytes < 1024 * 1024 * 1024) {
		return `${Math.round(bytes / (1024 * 1024))} MB`
	}
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export function assertDriveQuotaAllowsUpload(
	state: AppState | null,
	zipBytes: number,
) {
	const { remaining } = driveQuotaUsage(state)
	const requiredBytes = zipBytes + APP_UPLOAD.driveQuotaSafetyBytes
	if (remaining === null || requiredBytes <= remaining) return
	throw new Error(
		`Owner Drive has ${formatDriveBytes(remaining)} available; this ZIP needs ${formatDriveBytes(requiredBytes)} including safety margin.`,
	)
}
