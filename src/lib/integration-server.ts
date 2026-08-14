import { createHash, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { APP_DOWNLOAD, APP_ENV } from "./app-config"
import {
	createSnapshotZipDownloadLink,
	ensureIntegrationSnapshots,
	loadOrCreateAppState,
	revokeZipDownloadLink,
	type AppState,
} from "./drive-state"

const integrationTokenSchema = z.string().min(32).max(512)
const repositoryNameSchema = z
	.string()
	.min(1)
	.max(100)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
const repositoryOwnerSchema = z
	.string()
	.trim()
	.min(1)
	.max(100)
	.refine((value) => !/[\\/\0]/.test(value))
const revisionSchema = z.string().regex(/^[0-9a-f]{64}$/)
const archiveLinkWindows = new Map<
	string,
	{ startedAt: number; count: number }
>()

export class IntegrationHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message)
	}
}

function configuredIntegrationToken() {
	const value = process.env[APP_ENV.integrationReadToken]?.trim()
	return value ? integrationTokenSchema.parse(value) : null
}

function bearerToken(request: Request) {
	const authorization = request.headers.get("authorization")
	if (!authorization) return null
	const match = /^Bearer ([^\s]+)$/.exec(authorization)
	if (!match) throw new IntegrationHttpError(401, "A Bearer token is required.")
	return match[1]
}

function tokensEqual(left: string, right: string) {
	const leftDigest = createHash("sha256").update(left).digest()
	const rightDigest = createHash("sha256").update(right).digest()
	return timingSafeEqual(leftDigest, rightDigest)
}

function assertArchiveLinkRate(request: Request) {
	const key = (
		request.headers.get("cf-connecting-ip") ??
		request.headers.get("x-forwarded-for")?.split(",")[0] ??
		request.headers.get("x-real-ip") ??
		"anonymous"
	).trim()
	const now = Date.now()
	const existing = archiveLinkWindows.get(key)
	if (
		!existing ||
		now - existing.startedAt >= APP_DOWNLOAD.linkCreationWindowMs
	) {
		archiveLinkWindows.set(key, { startedAt: now, count: 1 })
		return
	}
	if (existing.count >= APP_DOWNLOAD.maxLinkCreationsPerWindow) {
		throw new IntegrationHttpError(429, "Too many archive download links.")
	}
	existing.count += 1
}

export function hasValidIntegrationToken(request: Request) {
	const supplied = bearerToken(request)
	if (!supplied) return false
	const configured = configuredIntegrationToken()
	if (!configured || !tokensEqual(supplied, configured)) {
		throw new IntegrationHttpError(401, "The integration token is invalid.")
	}
	return true
}

async function ownerDriveAccessToken() {
	const refreshToken = process.env[APP_ENV.googleDriveRefreshToken]
	const clientId = process.env[APP_ENV.googleDriveClientId]?.trim()
	const clientSecret = process.env[APP_ENV.googleDriveClientSecret]
	if (!refreshToken || !clientId || !clientSecret) {
		throw new IntegrationHttpError(503, "Repository storage is not configured.")
	}
	const response = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}),
	})
	if (!response.ok) {
		throw new IntegrationHttpError(
			502,
			"Repository storage authorization failed.",
		)
	}
	const data = (await response.json()) as { access_token?: string }
	if (!data.access_token) {
		throw new IntegrationHttpError(
			502,
			"Repository storage returned no access token.",
		)
	}
	return data.access_token
}

function integrationActorEmail() {
	const email = process.env[APP_ENV.adminEmails]?.split(",")[0]?.trim()
	if (!email) {
		throw new IntegrationHttpError(
			503,
			"Repository administration is not configured.",
		)
	}
	return email
}

export async function loadIntegrationState() {
	const accessToken = await ownerDriveAccessToken()
	let state = await loadOrCreateAppState(accessToken, integrationActorEmail(), {
		includeRepositoryDetails: false,
	})
	const missing = state.repositories
		.filter(
			(repository) =>
				!repository.archived &&
				!state.repositorySnapshots[repository.id]?.length,
		)
		.map((repository) => repository.id)
	if (missing.length) {
		state = await loadOrCreateAppState(accessToken, integrationActorEmail(), {
			repositoryIds: missing,
		})
		state = await ensureIntegrationSnapshots(accessToken, state)
	}
	return { accessToken, state }
}

function latestSnapshot(state: AppState, repositoryId: string) {
	return state.repositorySnapshots[repositoryId]?.at(-1) ?? null
}

export function integrationRepositoryList(
	state: AppState,
	includePrivate: boolean,
) {
	return state.repositories
		.filter(
			(repository) =>
				!repository.archived &&
				(includePrivate || repository.visibility === "public"),
		)
		.map((repository) => {
			const snapshot = latestSnapshot(state, repository.id)
			return {
				id: repository.id,
				owner: repository.owner,
				name: repository.name,
				description: repository.description ?? null,
				visibility: repository.visibility,
				defaultBranch: repository.defaultBranch,
				updatedAt: repository.updatedAt,
				latestSnapshot: snapshot
					? {
							revision: snapshot.revision,
							sha256: snapshot.sha256,
							archiveBytes: snapshot.archiveBytes,
							createdAt: snapshot.createdAt,
							source: snapshot.source,
							pullRequestNumber: snapshot.pullRequestNumber,
						}
					: null,
			}
		})
		.sort((left, right) => left.id.localeCompare(right.id))
}

export function integrationEventPage(
	state: AppState,
	after: number,
	limit: number,
) {
	const events = state.integrationEvents
		.filter((event) => event.cursor > after)
		.sort((left, right) => left.cursor - right.cursor)
		.slice(0, limit)
	const nextCursor = events.at(-1)?.cursor ?? after
	return {
		events,
		nextCursor,
		hasMore: state.integrationEvents.some((event) => event.cursor > nextCursor),
	}
}

export async function exactSnapshotArchive({
	request,
	owner,
	repositoryName,
	revision,
}: {
	request: Request
	owner: string
	repositoryName: string
	revision: string
}) {
	assertArchiveLinkRate(request)
	const normalizedOwner = repositoryOwnerSchema.parse(owner)
	const normalizedName = repositoryNameSchema.parse(repositoryName)
	const normalizedRevision = revisionSchema.parse(revision)
	const { accessToken, state } = await loadIntegrationState()
	const repository = state.repositories.find(
		(candidate) =>
			candidate.owner === normalizedOwner && candidate.name === normalizedName,
	)
	if (!repository || repository.archived) {
		throw new IntegrationHttpError(404, "Repository not found.")
	}
	if (
		repository.visibility !== "public" &&
		!hasValidIntegrationToken(request)
	) {
		throw new IntegrationHttpError(401, "A Bearer token is required.")
	}
	const snapshot = state.repositorySnapshots[repository.id]?.find(
		(candidate) => candidate.revision === normalizedRevision,
	)
	if (!snapshot) throw new IntegrationHttpError(404, "Snapshot not found.")
	const browserApiKey = process.env[APP_ENV.googleDriveBrowserApiKey]?.trim()
	if (!browserApiKey) {
		throw new IntegrationHttpError(
			503,
			"Direct archive downloads are unavailable.",
		)
	}
	const link = await createSnapshotZipDownloadLink({
		accessToken,
		state,
		snapshot,
		name: `${repository.name}-${snapshot.revision}.zip`,
		browserApiKey,
	})
	globalThis.setTimeout(() => {
		void revokeZipDownloadLink({
			accessToken,
			fileId: link.fileId,
			folderId: link.folderId,
			permissionId: link.permissionId,
		}).catch(() => undefined)
	}, 60_000)
	return { link, repository, snapshot }
}

export function integrationErrorResponse(error: unknown) {
	if (error instanceof IntegrationHttpError) {
		return Response.json({ error: error.message }, { status: error.status })
	}
	if (error instanceof z.ZodError) {
		return Response.json({ error: "The request is invalid." }, { status: 400 })
	}
	console.error("Integration API request failed", error)
	return Response.json(
		{ error: "The integration request failed." },
		{ status: 500 },
	)
}

export function integrationConfigured() {
	try {
		return configuredIntegrationToken() !== null
	} catch {
		return false
	}
}
