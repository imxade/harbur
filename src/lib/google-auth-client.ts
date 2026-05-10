import { GOOGLE_AUTH } from "./app-config"

export interface GoogleIdentityProfile {
	id: string
	email: string
	role: "anonymous" | "user" | "admin"
}

type GoogleCodeResponse = {
	code?: string
	error?: string
	error_description?: string
}

type GooglePopupError = {
	type?: "popup_failed_to_open" | "popup_closed" | "unknown"
}

type GoogleCodeClient = {
	requestCode: () => void
}

type GoogleIdentityServices = {
	accounts: {
		oauth2: {
			initCodeClient: (config: {
				client_id: string
				scope: string
				ux_mode: "popup"
				callback: (response: GoogleCodeResponse) => void
				error_callback?: (error: GooglePopupError) => void
				include_granted_scopes?: boolean
				select_account?: boolean
			}) => GoogleCodeClient
		}
	}
}

declare global {
	interface Window {
		google?: GoogleIdentityServices
	}
}

const GOOGLE_LOGIN_SCOPES = GOOGLE_AUTH.loginScopes.join(" ")
const GOOGLE_DRIVE_SCOPES = GOOGLE_AUTH.driveConsentScopes.join(" ")
let googleIdentityServicesPromise: Promise<GoogleIdentityServices> | null = null

export function isGoogleLoginConfigured(clientId?: string | null) {
	return (clientId ?? "").trim().length > 0
}

export function preloadGoogleIdentityServices() {
	if (typeof window === "undefined") return Promise.resolve(null)
	return loadGoogleIdentityServices()
		.then(() => null)
		.catch(() => null)
}

export async function requestGoogleLoginCode(clientId: string) {
	return await requestGoogleAuthorizationCode(clientId, GOOGLE_LOGIN_SCOPES)
}

export async function requestGoogleDriveAuthorizationCode(clientId: string) {
	return await requestGoogleAuthorizationCode(clientId, GOOGLE_DRIVE_SCOPES)
}

async function requestGoogleAuthorizationCode(clientId: string, scope: string) {
	if (!clientId) throw new Error("Google login is not configured.")
	const google = await loadGoogleIdentityServices()
	const redirectUri = window.location.origin
	const code = await new Promise<string>((resolve, reject) => {
		let settled = false
		const timeout = setTimeout(() => {
			if (settled) return
			settled = true
			reject(new Error("Google authorization timed out. Try again."))
		}, GOOGLE_AUTH.loginTimeoutMs)

		const finish = (callback: () => void) => {
			if (settled) return
			settled = true
			clearTimeout(timeout)
			callback()
		}

		const client = google.accounts.oauth2.initCodeClient({
			client_id: clientId,
			scope,
			ux_mode: "popup",
			include_granted_scopes: true,
			select_account: true,
			callback: (response) => {
				finish(() => {
					if (response.error) {
						reject(
							new Error(
								`Google authorization failed: ${
									response.error_description ?? response.error
								}`,
							),
						)
						return
					}
					if (!response.code) {
						reject(
							new Error("Google authorization returned no authorization code."),
						)
						return
					}
					resolve(response.code)
				})
			},
			error_callback: (error) => {
				finish(() => {
					if (error.type === "popup_closed") {
						reject(
							new Error("Google authorization was closed before it finished."),
						)
						return
					}
					if (error.type === "popup_failed_to_open") {
						reject(new Error("Google authorization popup failed to open."))
						return
					}
					reject(new Error("Google authorization failed."))
				})
			},
		})

		client.requestCode()
	})
	return { code, redirectUri }
}

function loadGoogleIdentityServices() {
	if (window.google?.accounts.oauth2) return Promise.resolve(window.google)
	googleIdentityServicesPromise ??= new Promise((resolve, reject) => {
		const existingScript = document.querySelector<HTMLScriptElement>(
			`script[src="${GOOGLE_AUTH.gisScriptUrl}"]`,
		)
		const script = existingScript ?? document.createElement("script")

		const onLoad = () => {
			if (window.google?.accounts.oauth2) {
				resolve(window.google)
				return
			}
			googleIdentityServicesPromise = null
			script.remove()
			reject(new Error("Google Identity Services did not initialize."))
		}

		script.addEventListener("load", onLoad, { once: true })
		script.addEventListener(
			"error",
			() => {
				googleIdentityServicesPromise = null
				script.remove()
				reject(new Error("Google Identity Services failed to load."))
			},
			{ once: true },
		)

		if (!existingScript) {
			script.src = GOOGLE_AUTH.gisScriptUrl
			script.async = true
			script.defer = true
			document.head.appendChild(script)
		}
	})
	return googleIdentityServicesPromise
}
