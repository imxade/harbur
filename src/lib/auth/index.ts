import type { Actor, RepositoryManifest } from "../types"
import { APP_SLUG } from "../app-config"

const ANONYMOUS_EMAIL = `anonymous@${APP_SLUG}.local`
export const ANONYMOUS_ACTOR = {
	id: "anonymous",
	email: ANONYMOUS_EMAIL,
	role: "anonymous",
} satisfies Actor

export function isAnonymousEmail(email: string) {
	return email.trim().toLowerCase() === ANONYMOUS_EMAIL
}

function parseAdminEmails(value = "") {
	return new Set(
		value
			.split(",")
			.map((email) => email.trim().toLowerCase())
			.filter(Boolean),
	)
}

export function isAdminEmail(email: string, allowlist: string | Set<string>) {
	const admins =
		typeof allowlist === "string" ? parseAdminEmails(allowlist) : allowlist
	return admins.has(email.trim().toLowerCase())
}

export function canMaintainRepository(
	actor: Actor,
	repository: RepositoryManifest,
	permission: "triage" | "merge" | "settings",
) {
	if (canOwnRepository(actor, repository)) return true
	if (
		(permission === "merge" || permission === "triage") &&
		repository.access.some(
			(grant) => grant.email.toLowerCase() === actor.email.toLowerCase(),
		)
	) {
		return true
	}
	return repository.maintainers.some(
		(maintainer) =>
			maintainer.email.toLowerCase() === actor.email.toLowerCase() &&
			maintainer.permissions.includes(permission),
	)
}

export function canOwnRepository(actor: Actor, repository: RepositoryManifest) {
	return repository.maintainers.some(
		(maintainer) =>
			maintainer.email.toLowerCase() === actor.email.toLowerCase() &&
			maintainer.permissions.includes("settings"),
	)
}
