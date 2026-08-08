import { APP_SLUG, APP_STORAGE, GOOGLE_DRIVE_API } from "./app-config"
import { timed } from "./timing"

const GOOGLE_DRIVE_RESULTS_FOLDER_NAME = APP_STORAGE.rootFolderName
const GOOGLE_DRIVE_APP_DATA_FILE_NAME = APP_STORAGE.appDataFileName

export interface GoogleDriveFile {
	id: string
	name: string
	mimeType?: string
	createdTime?: string
	modifiedTime?: string
	parents?: string[]
	size?: string
	version?: string
	webViewLink?: string
}

export type GoogleDrivePermission = {
	id: string
	type?: string
	role?: string
	allowFileDiscovery?: boolean
}

export type GoogleDriveStorageQuota = {
	limit?: string
	usage?: string
	usageInDrive?: string
	usageInDriveTrash?: string
}

type GoogleDriveJsonDocument = {
	file: GoogleDriveFile
	raw: string
}

export class GoogleDriveConflictError extends Error {
	constructor(message = "Google Drive document changed before save.") {
		super(message)
		this.name = "GoogleDriveConflictError"
	}
}

function escapeDriveQueryValue(value: string) {
	return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
}

async function ensureDriveResponse(response: Response) {
	if (response.ok) return response

	let detail = response.statusText || "Request failed."
	try {
		const data = await response.json()
		const message =
			typeof data?.error?.message === "string"
				? data.error.message
				: typeof data?.error_description === "string"
					? data.error_description
					: null
		if (message) detail = message
	} catch {
		try {
			const text = await response.text()
			if (text) detail = text
		} catch {
			// Ignore secondary parsing failures.
		}
	}

	throw new Error(`Google Drive request failed (${response.status}): ${detail}`)
}

async function driveJsonRequest<T>(
	input: string,
	accessToken: string,
	init?: RequestInit,
) {
	const headers = new Headers(init?.headers)
	headers.set("Authorization", `Bearer ${accessToken}`)

	const response = await fetch(input, {
		...init,
		headers,
	})
	await ensureDriveResponse(response)
	return (await response.json()) as T
}

async function driveFetchWithRetry(input: string, init?: RequestInit) {
	let lastResponse: Response | null = null
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const response = await fetch(input, init)
		if (response.ok || ![429, 500, 502, 503, 504].includes(response.status)) {
			return response
		}
		lastResponse = response
		await new Promise((resolve) =>
			setTimeout(resolve, 200 * 2 ** attempt + Math.floor(Math.random() * 100)),
		)
	}
	return lastResponse ?? fetch(input, init)
}

function createMultipartBody(metadata: Record<string, unknown>, blob: Blob) {
	const boundary = `${APP_SLUG}-${crypto.randomUUID()}`
	const body = new Blob(
		[
			`--${boundary}\r\n`,
			"Content-Type: application/json; charset=UTF-8\r\n\r\n",
			JSON.stringify(metadata),
			"\r\n",
			`--${boundary}\r\n`,
			`Content-Type: ${blob.type || "application/octet-stream"}\r\n\r\n`,
			blob,
			"\r\n",
			`--${boundary}--`,
		],
		{
			type: `multipart/related; boundary=${boundary}`,
		},
	)

	return {
		body,
		contentType: `multipart/related; boundary=${boundary}`,
	}
}

async function loadGoogleDriveAppDataFile(accessToken: string, name: string) {
	const file = await findGoogleDriveAppDataFile(accessToken, name)
	if (!file) return null
	return await loadGoogleDriveAppDataFileMedia(accessToken, file)
}

async function findGoogleDriveAppDataFile(accessToken: string, name: string) {
	const query = encodeURIComponent(
		`name='${escapeDriveQueryValue(name)}' and trashed=false`,
	)
	const response = await timed(
		"drive.appdata.file.lookup",
		() =>
			driveJsonRequest<{
				files?: GoogleDriveFile[]
			}>(
				`${GOOGLE_DRIVE_API.filesUrl}?spaces=appDataFolder&q=${query}&fields=files(id,name,modifiedTime,version)&pageSize=${GOOGLE_DRIVE_API.exactSearchPageSize}`,
				accessToken,
			),
		({ result }) => ({
			name,
			files: result?.files?.length ?? 0,
			pageSize: GOOGLE_DRIVE_API.exactSearchPageSize,
		}),
	)

	return response.files?.[0] ?? null
}

async function loadGoogleDriveAppDataFileMedia(
	accessToken: string,
	file: GoogleDriveFile,
	prefix?: string,
) {
	const raw = await timed(
		"drive.appdata.file.media.load",
		async () => {
			const mediaResponse = await driveFetchWithRetry(
				`${GOOGLE_DRIVE_API.filesUrl}/${encodeURIComponent(file.id)}?alt=media`,
				{
					headers: {
						Authorization: `Bearer ${accessToken}`,
					},
				},
			)
			await ensureDriveResponse(mediaResponse)
			return await mediaResponse.text()
		},
		({ result }) => ({
			name: file.name,
			fileId: file.id,
			prefix,
			bytes: result?.length,
		}),
	)

	return { file, raw }
}

export async function loadGoogleDriveFileByName(
	accessToken: string,
	parentId: string,
	name: string,
) {
	const file = await findGoogleDriveFileByName(accessToken, parentId, name)
	if (!file) return null
	return await loadGoogleDriveFileMedia(accessToken, file)
}

async function findGoogleDriveFileByName(
	accessToken: string,
	parentId: string,
	name: string,
) {
	const query = encodeURIComponent(
		`'${escapeDriveQueryValue(parentId)}' in parents and name='${escapeDriveQueryValue(name)}' and trashed=false`,
	)
	const response = await timed(
		"drive.file.lookup",
		() =>
			driveJsonRequest<{
				files?: GoogleDriveFile[]
			}>(
				`${GOOGLE_DRIVE_API.filesUrl}?spaces=drive&q=${query}&fields=files(id,name,modifiedTime,version,webViewLink)&pageSize=${GOOGLE_DRIVE_API.exactSearchPageSize}`,
				accessToken,
			),
		({ result }) => ({
			parentId,
			name,
			files: result?.files?.length ?? 0,
			pageSize: GOOGLE_DRIVE_API.exactSearchPageSize,
		}),
	)

	return response.files?.[0] ?? null
}

export async function loadGoogleDriveFilesByPrefix(
	accessToken: string,
	parentId: string,
	prefix: string,
) {
	const documents: GoogleDriveJsonDocument[] = []
	let pageToken: string | undefined
	let page = 0
	do {
		page += 1
		const query = encodeURIComponent(
			`'${escapeDriveQueryValue(parentId)}' in parents and name contains '${escapeDriveQueryValue(prefix)}' and trashed=false`,
		)
		const pageQuery = pageToken
			? `&pageToken=${encodeURIComponent(pageToken)}`
			: ""
		const response = await timed(
			"drive.files.prefix.list",
			() =>
				driveJsonRequest<{
					nextPageToken?: string
					files?: GoogleDriveFile[]
				}>(
					`${GOOGLE_DRIVE_API.filesUrl}?spaces=drive&q=${query}&fields=nextPageToken,files(id,name,modifiedTime,version,webViewLink)&pageSize=${GOOGLE_DRIVE_API.prefixSearchPageSize}${pageQuery}`,
					accessToken,
				),
			({ result }) => ({
				parentId,
				prefix,
				page,
				files: result?.files?.length ?? 0,
				nextPage: Boolean(result?.nextPageToken),
				pageSize: GOOGLE_DRIVE_API.prefixSearchPageSize,
			}),
		)
		const files = (response.files ?? []).filter((file) =>
			file.name.startsWith(prefix),
		)
		documents.push(
			...(await Promise.all(
				files.map((file) =>
					loadGoogleDriveFileMedia(accessToken, file, prefix),
				),
			)),
		)
		pageToken = response.nextPageToken
	} while (pageToken)

	return documents
}

export async function listGoogleDriveChildFoldersByPrefix({
	accessToken,
	parentId,
	prefix,
}: {
	accessToken: string
	parentId: string
	prefix: string
}) {
	const folders: GoogleDriveFile[] = []
	let pageToken: string | undefined
	let page = 0
	do {
		page += 1
		const query = encodeURIComponent(
			`'${escapeDriveQueryValue(parentId)}' in parents and name contains '${escapeDriveQueryValue(prefix)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
		)
		const pageQuery = pageToken
			? `&pageToken=${encodeURIComponent(pageToken)}`
			: ""
		const response = await timed(
			"drive.folders.prefix.list",
			() =>
				driveJsonRequest<{
					nextPageToken?: string
					files?: GoogleDriveFile[]
				}>(
					`${GOOGLE_DRIVE_API.filesUrl}?spaces=drive&q=${query}&fields=nextPageToken,files(id,name,mimeType,createdTime,modifiedTime,version,webViewLink)&pageSize=${GOOGLE_DRIVE_API.prefixSearchPageSize}${pageQuery}`,
					accessToken,
				),
			({ result }) => ({
				parentId,
				prefix,
				page,
				folders: result?.files?.length ?? 0,
				nextPage: Boolean(result?.nextPageToken),
				pageSize: GOOGLE_DRIVE_API.prefixSearchPageSize,
			}),
		)
		folders.push(
			...(response.files ?? []).filter((folder) =>
				folder.name.startsWith(prefix),
			),
		)
		pageToken = response.nextPageToken
	} while (pageToken)

	return folders
}

async function loadGoogleDriveFileMedia(
	accessToken: string,
	file: GoogleDriveFile,
	prefix?: string,
) {
	const raw = await timed(
		"drive.file.media.load",
		async () => {
			const mediaResponse = await driveFetchWithRetry(
				`${GOOGLE_DRIVE_API.filesUrl}/${encodeURIComponent(file.id)}?alt=media`,
				{
					headers: {
						Authorization: `Bearer ${accessToken}`,
					},
				},
			)
			await ensureDriveResponse(mediaResponse)
			return await mediaResponse.text()
		},
		({ result }) => ({
			name: file.name,
			fileId: file.id,
			prefix,
			bytes: result?.length,
		}),
	)

	return { file, raw }
}

export async function downloadGoogleDriveFile(
	accessToken: string,
	fileId: string,
	maxBytes = 256 * 1024 * 1024,
) {
	const response = await driveFetchWithRetry(
		`${GOOGLE_DRIVE_API.filesUrl}/${encodeURIComponent(fileId)}?alt=media`,
		{
			headers: { Authorization: `Bearer ${accessToken}` },
		},
	)
	await ensureDriveResponse(response)
	const declaredBytes = Number(response.headers.get("content-length") ?? 0)
	if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
		throw new Error("Google Drive file exceeds the download size limit.")
	}
	if (!response.body) return new Uint8Array()
	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let totalBytes = 0
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		totalBytes += value.byteLength
		if (totalBytes > maxBytes) {
			await reader.cancel()
			throw new Error("Google Drive file exceeds the download size limit.")
		}
		chunks.push(value)
	}
	const bytes = new Uint8Array(totalBytes)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return bytes
}

export async function saveGoogleDriveFileByName({
	accessToken,
	parentId,
	name,
	raw,
	expectedVersion,
}: {
	accessToken: string
	parentId: string
	name: string
	raw: string
	expectedVersion?: string
}) {
	const existing = await findGoogleDriveFileByName(accessToken, parentId, name)
	if (
		expectedVersion &&
		existing?.version &&
		existing.version !== expectedVersion
	) {
		throw new GoogleDriveConflictError()
	}
	const blob = new Blob([raw], { type: "application/json" })
	const metadata = existing ? { name } : { name, parents: [parentId] }
	const { body, contentType } = createMultipartBody(metadata, blob)
	const method = existing ? "PATCH" : "POST"
	const endpoint = existing
		? `${GOOGLE_DRIVE_API.uploadFilesUrl}/${encodeURIComponent(existing.id)}?uploadType=multipart&fields=id,name,modifiedTime,version,webViewLink`
		: `${GOOGLE_DRIVE_API.uploadFilesUrl}?uploadType=multipart&fields=id,name,modifiedTime,version,webViewLink`

	return await timed(
		"drive.file.upload",
		() =>
			driveJsonRequest<GoogleDriveFile>(endpoint, accessToken, {
				method,
				headers: {
					"Content-Type": contentType,
				},
				body,
			}),
		({ result }) => ({
			parentId,
			name,
			method,
			fileId: result?.id,
			bytes: blob.size,
			expectedVersion: Boolean(expectedVersion),
			existingVersion: existing?.version,
			savedVersion: result?.version,
		}),
	)
}

export async function createGoogleDriveFile({
	accessToken,
	parentId,
	name,
	raw,
}: {
	accessToken: string
	parentId: string
	name: string
	raw: string
}) {
	const blob = new Blob([raw], { type: "application/json" })
	const { body, contentType } = createMultipartBody(
		{ name, parents: [parentId] },
		blob,
	)

	return await timed(
		"drive.file.create",
		() =>
			driveJsonRequest<GoogleDriveFile>(
				`${GOOGLE_DRIVE_API.uploadFilesUrl}?uploadType=multipart&fields=id,name,modifiedTime,version,webViewLink`,
				accessToken,
				{
					method: "POST",
					headers: {
						"Content-Type": contentType,
					},
					body,
				},
			),
		({ result }) => ({
			parentId,
			name,
			fileId: result?.id,
			bytes: blob.size,
			savedVersion: result?.version,
		}),
	)
}

export async function deleteGoogleDriveFileByName(
	accessToken: string,
	parentId: string,
	name: string,
) {
	const existing = await findGoogleDriveFileByName(accessToken, parentId, name)
	if (!existing) return
	await deleteGoogleDriveFile(accessToken, existing.id)
}

async function saveGoogleDriveAppDataFile(
	accessToken: string,
	name: string,
	raw: string,
	expectedVersion?: string,
) {
	const existing = await findGoogleDriveAppDataFile(accessToken, name)
	if (
		expectedVersion &&
		existing?.version &&
		existing.version !== expectedVersion
	) {
		throw new GoogleDriveConflictError()
	}
	const blob = new Blob([raw], { type: "application/json" })
	const metadata = existing ? { name } : { name, parents: ["appDataFolder"] }
	const { body, contentType } = createMultipartBody(metadata, blob)
	const method = existing ? "PATCH" : "POST"
	const endpoint = existing
		? `${GOOGLE_DRIVE_API.uploadFilesUrl}/${encodeURIComponent(existing.id)}?uploadType=multipart&fields=id,name,modifiedTime,version`
		: `${GOOGLE_DRIVE_API.uploadFilesUrl}?uploadType=multipart&fields=id,name,modifiedTime,version`

	return await timed(
		"drive.appdata.file.upload",
		() =>
			driveJsonRequest<GoogleDriveFile>(endpoint, accessToken, {
				method,
				headers: {
					"Content-Type": contentType,
				},
				body,
			}),
		({ result }) => ({
			name,
			method,
			fileId: result?.id,
			bytes: blob.size,
			expectedVersion: Boolean(expectedVersion),
			existingVersion: existing?.version,
			savedVersion: result?.version,
		}),
	)
}

async function deleteGoogleDriveAppDataFile(accessToken: string, name: string) {
	const existing = await findGoogleDriveAppDataFile(accessToken, name)
	if (!existing) return
	await deleteGoogleDriveFile(accessToken, existing.id)
}

export async function loadGoogleDriveAppDataDocument(accessToken: string) {
	return await loadGoogleDriveAppDataFile(
		accessToken,
		GOOGLE_DRIVE_APP_DATA_FILE_NAME,
	)
}

export async function saveGoogleDriveAppDataDocument(
	accessToken: string,
	raw: string,
	expectedVersion?: string,
) {
	return await saveGoogleDriveAppDataFile(
		accessToken,
		GOOGLE_DRIVE_APP_DATA_FILE_NAME,
		raw,
		expectedVersion,
	)
}

export async function deleteGoogleDriveAppDataDocument(accessToken: string) {
	await deleteGoogleDriveAppDataFile(
		accessToken,
		GOOGLE_DRIVE_APP_DATA_FILE_NAME,
	)
}

async function findGoogleDriveResultsFolder(accessToken: string) {
	const query = encodeURIComponent(
		`name='${escapeDriveQueryValue(GOOGLE_DRIVE_RESULTS_FOLDER_NAME)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
	)
	const response = await driveJsonRequest<{
		files?: GoogleDriveFile[]
	}>(
		`${GOOGLE_DRIVE_API.filesUrl}?spaces=drive&q=${query}&fields=files(id,name,webViewLink)&pageSize=${GOOGLE_DRIVE_API.exactSearchPageSize}`,
		accessToken,
	)

	return response.files?.[0] ?? null
}

async function createGoogleDriveResultsFolder(accessToken: string) {
	return await driveJsonRequest<GoogleDriveFile>(
		`${GOOGLE_DRIVE_API.filesUrl}?fields=id,name,webViewLink`,
		accessToken,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json; charset=UTF-8",
			},
			body: JSON.stringify({
				name: GOOGLE_DRIVE_RESULTS_FOLDER_NAME,
				mimeType: "application/vnd.google-apps.folder",
			}),
		},
	)
}

export async function ensureGoogleDriveResultsFolder(accessToken: string) {
	return (
		(await findGoogleDriveResultsFolder(accessToken)) ??
		(await createGoogleDriveResultsFolder(accessToken))
	)
}

export async function createGoogleDriveFolder({
	accessToken,
	name,
	parentId,
}: {
	accessToken: string
	name: string
	parentId?: string
}) {
	return await driveJsonRequest<GoogleDriveFile>(
		`${GOOGLE_DRIVE_API.filesUrl}?fields=id,name,webViewLink`,
		accessToken,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json; charset=UTF-8",
			},
			body: JSON.stringify({
				name,
				mimeType: "application/vnd.google-apps.folder",
				parents: parentId ? [parentId] : undefined,
			}),
		},
	)
}

export async function copyGoogleDriveFile({
	accessToken,
	fileId,
	name,
	parentId,
}: {
	accessToken: string
	fileId: string
	name: string
	parentId: string
}) {
	return await driveJsonRequest<GoogleDriveFile>(
		`${GOOGLE_DRIVE_API.filesUrl}/${encodeURIComponent(fileId)}/copy?fields=id,name,mimeType,parents,size,version,webViewLink`,
		accessToken,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json; charset=UTF-8",
			},
			body: JSON.stringify({
				name,
				parents: [parentId],
			}),
		},
	)
}

export async function uploadFileToGoogleDrive({
	accessToken,
	blob,
	name,
	parentId,
}: {
	accessToken: string
	blob: Blob
	name: string
	parentId: string
}) {
	const uploadUrl = await createGoogleDriveUploadSession({
		accessToken,
		parentId,
		name,
		contentType: blob.type || "application/octet-stream",
		contentLength: blob.size,
	})
	const uploadResponse = await driveFetchWithRetry(uploadUrl, {
		method: "PUT",
		headers: {
			"Content-Type": blob.type || "application/octet-stream",
		},
		body: blob,
	})
	await ensureDriveResponse(uploadResponse)
	return (await uploadResponse.json()) as GoogleDriveFile
}

export async function createGoogleDriveUploadSession({
	accessToken,
	parentId,
	name,
	contentType,
	contentLength,
	origin,
}: {
	accessToken: string
	parentId: string
	name: string
	contentType: string
	contentLength: number
	origin?: string
}) {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json; charset=UTF-8",
		"X-Upload-Content-Type": contentType,
		"X-Upload-Content-Length": String(contentLength),
	}
	if (origin) headers.Origin = origin
	const initResponse = await driveFetchWithRetry(
		`${GOOGLE_DRIVE_API.uploadFilesUrl}?uploadType=resumable&fields=id,name,webViewLink`,
		{
			method: "POST",
			headers,
			body: JSON.stringify({
				name,
				parents: [parentId],
			}),
		},
	)
	await ensureDriveResponse(initResponse)

	const uploadUrl = initResponse.headers.get("Location")
	if (!uploadUrl) {
		throw new Error("Google Drive did not return an upload session URL.")
	}
	return uploadUrl
}

export async function moveGoogleDriveFile({
	accessToken,
	fileId,
	addParentId,
	removeParentId,
	name,
}: {
	accessToken: string
	fileId: string
	addParentId: string
	removeParentId: string
	name: string
}) {
	const query = new URLSearchParams({
		addParents: addParentId,
		removeParents: removeParentId,
		fields: "id,name,parents,size,version,webViewLink",
	})
	return await timed(
		"drive.file.move",
		() =>
			driveJsonRequest<GoogleDriveFile>(
				`${GOOGLE_DRIVE_API.filesUrl}/${encodeURIComponent(fileId)}?${query}`,
				accessToken,
				{
					method: "PATCH",
					headers: {
						"Content-Type": "application/json; charset=UTF-8",
					},
					body: JSON.stringify({ name }),
				},
			),
		({ result }) => ({
			fileId,
			name: result?.name,
			addParentId,
			removeParentId,
		}),
	)
}

export async function getGoogleDriveFileMetadata(
	accessToken: string,
	fileId: string,
) {
	return await timed(
		"drive.file.metadata.load",
		() =>
			driveJsonRequest<GoogleDriveFile>(
				`${GOOGLE_DRIVE_API.filesUrl}/${encodeURIComponent(fileId)}?fields=id,name,mimeType,parents,size,version,webViewLink`,
				accessToken,
			),
		({ result }) => ({
			fileId,
			name: result?.name,
			bytes: result?.size,
		}),
	)
}

export async function createGoogleDriveAnyoneReaderPermission(
	accessToken: string,
	fileId: string,
) {
	return await driveJsonRequest<GoogleDrivePermission>(
		`${GOOGLE_DRIVE_API.filesUrl}/${encodeURIComponent(fileId)}/permissions?fields=id,type,role,allowFileDiscovery`,
		accessToken,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json; charset=UTF-8",
			},
			body: JSON.stringify({
				type: "anyone",
				role: "reader",
				allowFileDiscovery: false,
			}),
		},
	)
}

export async function deleteGoogleDrivePermission({
	accessToken,
	fileId,
	permissionId,
}: {
	accessToken: string
	fileId: string
	permissionId: string
}) {
	const response = await fetch(
		`${GOOGLE_DRIVE_API.filesUrl}/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}`,
		{
			method: "DELETE",
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		},
	)
	if (response.status === 404) return
	await ensureDriveResponse(response)
}

export function googleDrivePublicFileMediaUrl(fileId: string, apiKey: string) {
	const params = new URLSearchParams({
		alt: "media",
		acknowledgeAbuse: "true",
		key: apiKey,
	})
	return `${GOOGLE_DRIVE_API.filesUrl}/${encodeURIComponent(fileId)}?${params}`
}

export async function getGoogleDriveStorageQuota(accessToken: string) {
	const response = await timed(
		"drive.about.quota.load",
		() =>
			driveJsonRequest<{ storageQuota?: GoogleDriveStorageQuota }>(
				`${GOOGLE_DRIVE_API.aboutUrl}?fields=storageQuota(limit,usage,usageInDrive,usageInDriveTrash)`,
				accessToken,
			),
		({ result }) => ({
			limit: result?.storageQuota?.limit,
			usage: result?.storageQuota?.usage,
		}),
	)
	return response.storageQuota ?? {}
}

export async function deleteGoogleDriveFile(
	accessToken: string,
	fileId: string,
) {
	const response = await fetch(
		`${GOOGLE_DRIVE_API.filesUrl}/${encodeURIComponent(fileId)}`,
		{
			method: "DELETE",
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		},
	)
	if (response.status === 404) return
	await ensureDriveResponse(response)
}
