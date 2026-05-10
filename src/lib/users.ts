export type OwnerNameUser = {
	ownerName: string
}

export function displayOwnerName(
	email: string,
	users: Record<string, OwnerNameUser>,
	fallbackName?: string,
) {
	const normalizedEmail = email.trim().toLowerCase()
	return users[normalizedEmail]?.ownerName ?? fallbackName?.trim() ?? "User"
}

export function replaceEmailsWithOwnerNames(
	value: string,
	users: Record<string, OwnerNameUser>,
) {
	return Object.entries(users).reduce(
		(text, [email, user]) =>
			text.replaceAll(new RegExp(escapeRegExp(email), "gi"), user.ownerName),
		value,
	)
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
