import { useServerFn } from "@tanstack/react-start"
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react"
import {
	isGoogleLoginConfigured,
	preloadGoogleIdentityServices,
	requestGoogleDriveAuthorizationCode,
	requestGoogleLoginCode,
	type GoogleIdentityProfile,
} from "../lib/google-auth-client"
import { ANONYMOUS_ACTOR } from "../lib/auth"
import {
	createClientZipWorkflowCache,
	type BeginZipUploadData,
	type ClientZipWorkflowContext,
} from "../lib/client-zip-workflows"
import type { DownloadFile } from "../lib/download-client"
import type { IssueState } from "../lib/issues"
import type { AppState, UploadProgress } from "../lib/drive-state"
import { createDefaultSettings } from "../lib/settings"
import {
	beginZipUploadServer,
	cancelZipUploadServer,
	closePullRequestServer,
	commentOnIssueServer,
	commentOnPullRequestServer,
	completeGitHubMirrorSyncUploadServer,
	completePullRequestUploadServer,
	completeRepositoryUploadServer,
	connectBackupDriveServer,
	connectOwnerDriveServer,
	createIssueServer,
	createPullRequestZipDownloadLinkServer,
	createRepositoryZipDownloadLinkServer,
	deleteBackupDriveServer,
	deleteRepositoryServer,
	disconnectBackupDriveServer,
	editIssueTitleServer,
	editIssueMessageServer,
	editPullRequestTitleServer,
	editPullRequestMessageServer,
	getAuthConfig,
	getDriveState,
	getRepositoryDriveState,
	getSessionState,
	loginWithGoogle,
	logoutSession,
	markNotificationsReadServer,
	mergePullRequestServer,
	reviewPullRequestServer,
	revokeZipDownloadLinkServer,
	transitionIssueServer,
	updateSettingsServer,
	updateRepositoryAccessServer,
	updateUserNameServer,
	watchRepositoryServer,
} from "../lib/server-functions"
import type { Actor, AppSettings, RepositoryPolicy } from "../lib/types"

function hasDueGitHubMirrorSync(state: AppState) {
	const intervalHours = state.settings.githubMirrorSyncIntervalHours
	if (intervalHours <= 0) return false
	const intervalMs = intervalHours * 60 * 60 * 1000
	const now = Date.now()
	return state.repositories.some((repository) => {
		if (!repository.githubMirror) return false
		const lastSyncedAt = repository.githubMirror.lastSyncedAt
		if (!lastSyncedAt) return true
		const parsed = Date.parse(lastSyncedAt)
		return !Number.isFinite(parsed) || now - parsed >= intervalMs
	})
}

async function loadZipWorkflows() {
	return await import("../lib/client-zip-workflows")
}

type AppShellState = {
	actor: Actor
	settings: AppSettings
	providerStatus:
		| "not-configured"
		| "ready"
		| "needs-auth"
		| "loading"
		| "owner-not-configured"
	isSigningIn: boolean
	user: GoogleIdentityProfile | null
	driveState: AppState | null
	uploadProgress: UploadProgress | null
	error: string | null
	loadRepositoryDetail: (
		repositoryId: string,
		options?: {
			issueNumber?: number
			pullRequestNumber?: number
		},
	) => Promise<void>
	signIn: () => Promise<void>
	signOut: () => Promise<void>
	createRepository: (input: {
		name?: string
		description?: string
		files?: File[]
		githubUrl?: string
	}) => Promise<void>
	watchRepository: (repositoryId: string, watched: boolean) => Promise<void>
	deleteRepository: (repositoryId: string) => Promise<void>
	markNotificationsRead: () => Promise<void>
	updateSettings: (settings: AppSettings) => Promise<void>
	updateUserName: (ownerName: string) => Promise<void>
	connectBackupDrive: () => Promise<void>
	connectOwnerDrive: () => Promise<string>
	disconnectBackupDrive: (targetId: string) => Promise<void>
	deleteBackupDrive: (targetId: string) => Promise<void>
	updateRepositoryAccess: (input: {
		repositoryId: string
		name?: string
		description?: string
		visibility: "public" | "private"
		policy: RepositoryPolicy
		accessEmails: string[]
	}) => Promise<void>
	createIssue: (input: {
		repositoryId: string
		title: string
		body: string
		labels: string[]
	}) => Promise<void>
	commentOnIssue: (input: {
		repositoryId: string
		issueNumber: number
		body: string
	}) => Promise<void>
	editIssueMessage: (input: {
		repositoryId: string
		issueNumber: number
		messageId: string
		body: string
	}) => Promise<void>
	editIssueTitle: (input: {
		repositoryId: string
		issueNumber: number
		title: string
	}) => Promise<void>
	transitionIssue: (input: {
		repositoryId: string
		issueNumber: number
		nextIssueState: IssueState
	}) => Promise<void>
	createPullRequest: (input: {
		repositoryId: string
		title: string
		body: string
		files: File[]
	}) => Promise<void>
	commentOnPullRequest: (input: {
		repositoryId: string
		pullRequestNumber: number
		body: string
	}) => Promise<void>
	editPullRequestMessage: (input: {
		repositoryId: string
		pullRequestNumber: number
		messageId: string
		body: string
	}) => Promise<void>
	editPullRequestTitle: (input: {
		repositoryId: string
		pullRequestNumber: number
		title: string
	}) => Promise<void>
	reviewPullRequest: (
		repositoryId: string,
		pullRequestNumber: number,
	) => Promise<void>
	closePullRequest: (
		repositoryId: string,
		pullRequestNumber: number,
	) => Promise<void>
	mergePullRequest: (
		repositoryId: string,
		pullRequestNumber: number,
	) => Promise<void>
	downloadPullRequestPreviewZip: (
		repositoryId: string,
		pullRequestNumber: number,
	) => Promise<DownloadFile>
	downloadRepositoryZip: (repositoryId: string) => Promise<DownloadFile>
}

const AppShellContext = createContext<AppShellState | null>(null)

function isOwnerDriveConfigError(cause: unknown) {
	return (
		cause instanceof Error &&
		cause.message.includes("Owner Drive authorization is not configured")
	)
}

function mergeDriveStates(current: AppState | null, incoming: AppState) {
	if (!current) return incoming
	const loadedRepositoryIds = incoming.loadedRepositoryIds ?? []
	const loadedRepositoryIdSet = new Set(loadedRepositoryIds)
	const loadedRepositoryFileIds = incoming.loadedRepositoryFileIds ?? []
	const loadedRepositoryReadmeIds = incoming.loadedRepositoryReadmeIds ?? []
	const loadedPullRequestFileIds = incoming.loadedPullRequestFileIds ?? []
	const loadedPullRequestFileIdSet = new Set(loadedPullRequestFileIds)
	const loadedThreadIdSet = new Set(incoming.loadedThreadIds ?? [])

	return {
		...current,
		...incoming,
		repositoryFiles: {
			...current.repositoryFiles,
			...Object.fromEntries(
				Object.entries(incoming.repositoryFiles).filter(([repositoryId]) =>
					loadedRepositoryFileIds.includes(repositoryId),
				),
			),
		},
		repositoryReadmeFiles: {
			...current.repositoryReadmeFiles,
			...Object.fromEntries(
				Object.entries(incoming.repositoryReadmeFiles).filter(
					([repositoryId]) => loadedRepositoryReadmeIds.includes(repositoryId),
				),
			),
		},
		repositoryZipFileIds: {
			...current.repositoryZipFileIds,
			...incoming.repositoryZipFileIds,
		},
		issues: mergeRepositoryThreadMaps(
			current.issues,
			incoming.issues,
			loadedRepositoryIdSet,
			loadedThreadIdSet,
		),
		pullRequests: mergePullRequestMaps(
			current.pullRequests,
			incoming.pullRequests,
			loadedRepositoryIdSet,
			loadedPullRequestFileIdSet,
			loadedThreadIdSet,
		),
		pullRequestZipFileIds: {
			...current.pullRequestZipFileIds,
			...incoming.pullRequestZipFileIds,
		},
		users: {
			...current.users,
			...incoming.users,
		},
		notifications: mergeNotificationMaps(
			current.notifications,
			incoming.notifications,
		),
		activity: mergeActivityRecords(current.activity, incoming.activity),
		loadedRepositoryIds: [
			...new Set([
				...(current.loadedRepositoryIds ?? []),
				...loadedRepositoryIds,
			]),
		],
		loadedRepositoryFileIds: [
			...new Set([
				...(current.loadedRepositoryFileIds ?? []),
				...loadedRepositoryFileIds,
			]),
		],
		loadedRepositoryReadmeIds: [
			...new Set([
				...(current.loadedRepositoryReadmeIds ?? []),
				...loadedRepositoryReadmeIds,
			]),
		],
		loadedPullRequestFileIds: [
			...new Set([
				...(current.loadedPullRequestFileIds ?? []),
				...loadedPullRequestFileIds,
			]),
		],
		loadedThreadIds: [
			...new Set([
				...(current.loadedThreadIds ?? []),
				...(incoming.loadedThreadIds ?? []),
			]),
		],
		repositoryStorageVersions: {
			...(current.repositoryStorageVersions ?? {}),
			...(incoming.repositoryStorageVersions ?? {}),
		},
	} satisfies AppState
}

function mergePullRequestMaps(
	current: AppState["pullRequests"],
	incoming: AppState["pullRequests"],
	loadedRepositoryIds: Set<string>,
	loadedPullRequestFileIds: Set<string>,
	loadedThreadIds: Set<string>,
) {
	const records = { ...current }
	for (const [repositoryId, incomingRecords] of Object.entries(incoming)) {
		records[repositoryId] = loadedRepositoryIds.has(repositoryId)
			? mergePullRequestRecords(
					records[repositoryId] ?? [],
					incomingRecords,
					loadedPullRequestFileIds,
					loadedThreadIds,
				)
			: incomingRecords
	}
	return records
}

function mergePullRequestRecords(
	current: AppState["pullRequests"][string],
	incoming: AppState["pullRequests"][string],
	loadedPullRequestFileIds: Set<string>,
	loadedThreadIds: Set<string>,
) {
	const records = new Map(current.map((record) => [record.id, record]))
	for (const record of incoming) {
		const existing = records.get(record.id)
		const merged = mergeThreadRecord(existing, record, loadedThreadIds)
		records.set(
			record.id,
			!loadedPullRequestFileIds.has(record.id) && existing?.files.length
				? { ...merged, files: existing.files }
				: merged,
		)
	}
	return [...records.values()]
		.sort(compareThreadRecords)
		.map((record, index) => ({ ...record, number: index + 1 }))
}

function mergeRepositoryThreadMaps<
	T extends {
		id: string
		number: number
		createdAt: string
		updatedAt?: string
		comments?: unknown[]
	},
>(
	current: Record<string, T[]>,
	incoming: Record<string, T[]>,
	loadedRepositoryIds: Set<string>,
	loadedThreadIds: Set<string>,
) {
	const records = { ...current }
	for (const [repositoryId, incomingRecords] of Object.entries(incoming)) {
		records[repositoryId] = loadedRepositoryIds.has(repositoryId)
			? mergeThreadRecords(
					records[repositoryId] ?? [],
					incomingRecords,
					loadedThreadIds,
				)
			: incomingRecords
	}
	return records
}

function mergeThreadRecords<
	T extends {
		id: string
		number: number
		createdAt: string
		updatedAt?: string
		comments?: unknown[]
	},
>(current: T[], incoming: T[], loadedThreadIds: Set<string>) {
	const records = new Map(current.map((record) => [record.id, record]))
	for (const record of incoming) {
		const existing = records.get(record.id)
		records.set(record.id, mergeThreadRecord(existing, record, loadedThreadIds))
	}
	return [...records.values()]
		.sort(compareThreadRecords)
		.map((record, index) => ({ ...record, number: index + 1 }))
}

function mergeThreadRecord<
	T extends {
		id: string
		createdAt: string
		updatedAt?: string
		comments?: unknown[]
	},
>(current: T | undefined, incoming: T, loadedThreadIds: Set<string>) {
	if (!current) return incoming
	if (
		!loadedThreadIds.has(incoming.id) &&
		current.comments?.length &&
		!incoming.comments?.length
	) {
		return {
			...incoming,
			comments: current.comments,
		}
	}
	return threadTimestamp(incoming) >= threadTimestamp(current)
		? incoming
		: current
}

function threadTimestamp(record: { createdAt: string; updatedAt?: string }) {
	return record.updatedAt ?? record.createdAt
}

function compareThreadRecords(
	left: { id: string; createdAt: string },
	right: { id: string; createdAt: string },
) {
	return (
		left.createdAt.localeCompare(right.createdAt) ||
		left.id.localeCompare(right.id)
	)
}

function mergeActivityRecords(
	current: AppState["activity"],
	incoming: AppState["activity"],
) {
	const records = new Map(current.map((record) => [record.id, record]))
	for (const record of incoming) records.set(record.id, record)
	return [...records.values()]
}

function mergeNotificationMaps(
	current: AppState["notifications"],
	incoming: AppState["notifications"],
) {
	const notifications = { ...current }
	for (const [email, incomingRecords] of Object.entries(incoming)) {
		notifications[email] = incomingRecords
	}
	return notifications
}

export default function AppShellProvider({
	children,
}: {
	children: React.ReactNode
}) {
	const getSessionStateFn = useServerFn(getSessionState)
	const getDriveStateFn = useServerFn(getDriveState)
	const getRepositoryDriveStateFn = useServerFn(getRepositoryDriveState)
	const getAuthConfigFn = useServerFn(getAuthConfig)
	const loginWithGoogleFn = useServerFn(loginWithGoogle)
	const logoutSessionFn = useServerFn(logoutSession)
	const beginZipUploadFn = useServerFn(beginZipUploadServer)
	const completeRepositoryUploadFn = useServerFn(completeRepositoryUploadServer)
	const completePullRequestUploadFn = useServerFn(
		completePullRequestUploadServer,
	)
	const completeGitHubMirrorSyncUploadFn = useServerFn(
		completeGitHubMirrorSyncUploadServer,
	)
	const cancelZipUploadFn = useServerFn(cancelZipUploadServer)
	const watchRepositoryFn = useServerFn(watchRepositoryServer)
	const deleteRepositoryFn = useServerFn(deleteRepositoryServer)
	const markNotificationsReadFn = useServerFn(markNotificationsReadServer)
	const updateSettingsFn = useServerFn(updateSettingsServer)
	const updateUserNameFn = useServerFn(updateUserNameServer)
	const connectBackupDriveFn = useServerFn(connectBackupDriveServer)
	const connectOwnerDriveFn = useServerFn(connectOwnerDriveServer)
	const disconnectBackupDriveFn = useServerFn(disconnectBackupDriveServer)
	const deleteBackupDriveFn = useServerFn(deleteBackupDriveServer)
	const updateRepositoryAccessFn = useServerFn(updateRepositoryAccessServer)
	const createIssueFn = useServerFn(createIssueServer)
	const commentOnIssueFn = useServerFn(commentOnIssueServer)
	const editIssueMessageFn = useServerFn(editIssueMessageServer)
	const editIssueTitleFn = useServerFn(editIssueTitleServer)
	const transitionIssueFn = useServerFn(transitionIssueServer)
	const commentOnPullRequestFn = useServerFn(commentOnPullRequestServer)
	const editPullRequestMessageFn = useServerFn(editPullRequestMessageServer)
	const editPullRequestTitleFn = useServerFn(editPullRequestTitleServer)
	const reviewPullRequestFn = useServerFn(reviewPullRequestServer)
	const closePullRequestFn = useServerFn(closePullRequestServer)
	const mergePullRequestFn = useServerFn(mergePullRequestServer)
	const downloadPullRequestZipFn = useServerFn(
		createPullRequestZipDownloadLinkServer,
	)
	const downloadRepositoryZipFn = useServerFn(
		createRepositoryZipDownloadLinkServer,
	)
	const revokeZipDownloadFn = useServerFn(revokeZipDownloadLinkServer)

	const [user, setUser] = useState<GoogleIdentityProfile | null>(null)
	const [driveState, setDriveState] = useState<AppState | null>(null)
	const [providerStatus, setProviderStatus] =
		useState<AppShellState["providerStatus"]>("loading")
	const [error, setError] = useState<string | null>(null)
	const [googleClientId, setGoogleClientId] = useState("")
	const [isSigningIn, setIsSigningIn] = useState(false)
	const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(
		null,
	)
	const mirrorSyncStarted = useRef(false)
	const driveStateRef = useRef<AppState | null>(null)
	const zipWorkflowCache = useRef(createClientZipWorkflowCache())

	useEffect(() => {
		driveStateRef.current = driveState
	}, [driveState])

	useEffect(() => {
		let active = true
		async function initializeAuth() {
			let authConfigured = false
			try {
				const config = await getAuthConfigFn()
				if (!active) return
				setGoogleClientId(config.googleClientId)
				authConfigured = isGoogleLoginConfigured(config.googleClientId)
				if (!authConfigured) {
					setProviderStatus("not-configured")
					setDriveState(await getDriveStateFn())
					return
				}
				void preloadGoogleIdentityServices()
				setProviderStatus("loading")
				const result = await getSessionStateFn()
				if (!active) return
				setUser(result.user)
				if (!result.user) {
					setProviderStatus("needs-auth")
					setDriveState(await getDriveStateFn())
					return
				}
				try {
					setDriveState(await getDriveStateFn())
					setProviderStatus("ready")
				} catch (cause) {
					if (isOwnerDriveConfigError(cause)) {
						setProviderStatus("owner-not-configured")
					} else {
						throw cause
					}
				}
			} catch (cause) {
				if (!active) return
				setError(
					cause instanceof Error
						? cause.message
						: authConfigured
							? "Session load failed."
							: "Auth config load failed.",
				)
				setProviderStatus(authConfigured ? "needs-auth" : "not-configured")
			}
		}
		void initializeAuth()
		return () => {
			active = false
		}
	}, [getAuthConfigFn, getDriveStateFn, getSessionStateFn])

	const actor: Actor = user
		? {
				id: user.id,
				email: user.email,
				role: user.role,
			}
		: ANONYMOUS_ACTOR

	function applyDriveState(nextState: AppState) {
		setDriveState((current) => {
			const merged = mergeDriveStates(current, nextState)
			driveStateRef.current = merged
			return merged
		})
	}

	const repositoryRootFolderId = useCallback(
		(repositoryId: string) => {
			return (driveStateRef.current ?? driveState)?.repositories.find(
				(repository) => repository.id === repositoryId,
			)?.rootFolderId
		},
		[driveState],
	)

	function withRepositoryRoot<T extends { repositoryId: string }>(input: T) {
		const rootFolderId = repositoryRootFolderId(input.repositoryId)
		return rootFolderId
			? { ...input, repositoryRootFolderId: rootFolderId }
			: input
	}

	const zipWorkflowContext = useCallback((): ClientZipWorkflowContext => {
		return {
			getState: () => driveStateRef.current,
			setState: (updater) => {
				setDriveState((current) => {
					const next = updater(current)
					driveStateRef.current = next
					return next
				})
			},
			setProgress: setUploadProgress,
			getRepositoryRootFolderId: repositoryRootFolderId,
			getOrigin: () => window.location.origin,
			beginZipUpload: async (data: BeginZipUploadData) =>
				await beginZipUploadFn({ data }),
			cancelZipUpload: async (uploadTicket: string) =>
				await cancelZipUploadFn({ data: { uploadTicket } }),
			revokeZipDownload: async (downloadTicket: string) =>
				await revokeZipDownloadFn({ data: { downloadTicket } }),
			completeRepositoryUpload: async (data) =>
				await completeRepositoryUploadFn({ data }),
			completePullRequestUpload: async (data) =>
				await completePullRequestUploadFn({ data }),
			completePullRequestMergeUpload: async (data) =>
				await mergePullRequestFn({ data }),
			completeGitHubMirrorSyncUpload: async (data) =>
				await completeGitHubMirrorSyncUploadFn({ data }),
			downloadRepositoryZip: async (data) =>
				await downloadRepositoryZipFn({ data }),
			downloadPullRequestZip: async (data) =>
				await downloadPullRequestZipFn({ data }),
		}
	}, [
		beginZipUploadFn,
		cancelZipUploadFn,
		completeGitHubMirrorSyncUploadFn,
		completePullRequestUploadFn,
		completeRepositoryUploadFn,
		downloadRepositoryZipFn,
		downloadPullRequestZipFn,
		mergePullRequestFn,
		repositoryRootFolderId,
		revokeZipDownloadFn,
	])

	useEffect(() => {
		if (mirrorSyncStarted.current) return
		if (!driveState || actor.role !== "admin") return
		if (!hasDueGitHubMirrorSync(driveState)) return
		mirrorSyncStarted.current = true
		let active = true
		void loadZipWorkflows()
			.then(({ syncDueGitHubMirrors }) =>
				syncDueGitHubMirrors({
					context: zipWorkflowContext(),
					cache: zipWorkflowCache.current,
					state: driveState,
					onState: (nextState) => {
						if (!active) return
						setDriveState((current) => mergeDriveStates(current, nextState))
						driveStateRef.current = mergeDriveStates(
							driveStateRef.current,
							nextState,
						)
					},
				}),
			)
			.then(() => {
				if (active) setUploadProgress(null)
			})
			.catch((cause) => {
				if (!active) return
				setError(
					cause instanceof Error ? cause.message : "GitHub mirror sync failed.",
				)
				setUploadProgress(null)
			})
		return () => {
			active = false
		}
	}, [actor.role, driveState, zipWorkflowContext])

	async function signIn() {
		setError(null)
		setIsSigningIn(true)
		setProviderStatus("loading")
		try {
			const auth = await requestGoogleLoginCode(googleClientId)
			const result = await loginWithGoogleFn({ data: auth })
			setUser(result.user)
			try {
				setDriveState(await getDriveStateFn())
				setProviderStatus("ready")
			} catch (cause) {
				if (isOwnerDriveConfigError(cause)) {
					setProviderStatus("owner-not-configured")
				} else {
					throw cause
				}
			}
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Google sign-in failed.",
			)
			setProviderStatus(
				isGoogleLoginConfigured(googleClientId)
					? "needs-auth"
					: "not-configured",
			)
		} finally {
			setIsSigningIn(false)
		}
	}

	async function signOut() {
		await logoutSessionFn()
		setUser(null)
		setDriveState(await getDriveStateFn())
		setProviderStatus(
			isGoogleLoginConfigured(googleClientId) ? "needs-auth" : "not-configured",
		)
	}

	function requireReadySession({ admin = false } = {}) {
		if (!driveState || !user) throw new Error("Sign in first.")
		if (admin && user.role !== "admin") {
			throw new Error("Admin access is required.")
		}
		return { currentDriveState: driveState, currentUser: user }
	}

	async function loadRepositoryDetail(
		repositoryId: string,
		options?: {
			issueNumber?: number
			pullRequestNumber?: number
		},
	) {
		const nextState = await getRepositoryDriveStateFn({
			data: {
				repositoryId,
				repositoryRootFolderId: repositoryRootFolderId(repositoryId),
				issueNumber: options?.issueNumber,
				pullRequestNumber: options?.pullRequestNumber,
			},
		})
		const mergedState = mergeDriveStates(driveState, nextState)
		applyDriveState(nextState)
		if (options?.pullRequestNumber) {
			const { loadPullRequestZipSnapshot } = await loadZipWorkflows()
			await loadPullRequestZipSnapshot(
				zipWorkflowContext(),
				zipWorkflowCache.current,
				repositoryId,
				options.pullRequestNumber,
				mergedState,
			)
		}
	}

	async function createRepository(input: {
		name?: string
		description?: string
		files?: File[]
		githubUrl?: string
	}) {
		const { currentDriveState, currentUser } = requireReadySession({
			admin: true,
		})
		setError(null)
		setUploadProgress(null)
		try {
			const repositoryName = input.name?.trim()
			const ownerName =
				currentDriveState.users[currentUser.email.toLowerCase()]?.ownerName ??
				currentDriveState.settings.ownerName
			if (!repositoryName) throw new Error("Repository name is required.")
			if (
				currentDriveState.repositories.some(
					(repository) =>
						repository.owner === ownerName &&
						repository.name === repositoryName,
				)
			) {
				throw new Error(
					`Repository already exists: ${ownerName}/${repositoryName}`,
				)
			}
			if (input.githubUrl) {
				const { uploadRepositoryFromGitHub } = await loadZipWorkflows()
				applyDriveState(
					await uploadRepositoryFromGitHub({
						context: zipWorkflowContext(),
						name: repositoryName,
						description: input.description,
						githubUrl: input.githubUrl,
					}),
				)
				return
			}
			const { uploadRepositoryFromFolder } = await loadZipWorkflows()
			applyDriveState(
				await uploadRepositoryFromFolder({
					context: zipWorkflowContext(),
					files: input.files ?? [],
					name: repositoryName,
					description: input.description,
				}),
			)
		} finally {
			setUploadProgress(null)
		}
	}

	async function watchRepository(repositoryId: string, watched: boolean) {
		requireReadySession()
		applyDriveState(
			await watchRepositoryFn({ data: { repositoryId, watched } }),
		)
	}

	async function deleteRepository(repositoryId: string) {
		requireReadySession({ admin: true })
		setError(null)
		applyDriveState(await deleteRepositoryFn({ data: { repositoryId } }))
	}

	async function markNotificationsRead() {
		requireReadySession()
		setError(null)
		applyDriveState(await markNotificationsReadFn())
	}

	async function updateSettings(settings: AppSettings) {
		requireReadySession({ admin: true })
		setError(null)
		applyDriveState(await updateSettingsFn({ data: settings }))
	}

	async function updateUserName(ownerName: string) {
		requireReadySession()
		setError(null)
		applyDriveState(await updateUserNameFn({ data: { ownerName } }))
	}

	async function connectBackupDrive() {
		requireReadySession({ admin: true })
		setError(null)
		const auth = await requestGoogleDriveAuthorizationCode(googleClientId)
		applyDriveState(await connectBackupDriveFn({ data: auth }))
	}

	async function connectOwnerDrive() {
		if (!user || user.role !== "admin") {
			throw new Error("Admin access is required.")
		}
		setError(null)
		const auth = await requestGoogleDriveAuthorizationCode(googleClientId)
		const result = await connectOwnerDriveFn({ data: auth })
		setDriveState(result.state)
		setProviderStatus("ready")
		return result.message ?? `Owner Drive connected: ${result.accountEmail}`
	}

	async function disconnectBackupDrive(targetId: string) {
		requireReadySession({ admin: true })
		setError(null)
		applyDriveState(await disconnectBackupDriveFn({ data: { targetId } }))
	}

	async function deleteBackupDrive(targetId: string) {
		requireReadySession({ admin: true })
		setError(null)
		applyDriveState(await deleteBackupDriveFn({ data: { targetId } }))
	}

	async function updateRepositoryAccess(input: {
		repositoryId: string
		name?: string
		description?: string
		visibility: "public" | "private"
		policy: RepositoryPolicy
		accessEmails: string[]
	}) {
		requireReadySession()
		setError(null)
		applyDriveState(
			await updateRepositoryAccessFn({ data: withRepositoryRoot(input) }),
		)
	}

	async function createIssue(input: {
		repositoryId: string
		title: string
		body: string
		labels: string[]
	}) {
		requireReadySession()
		applyDriveState(await createIssueFn({ data: withRepositoryRoot(input) }))
	}

	async function commentOnIssue(input: {
		repositoryId: string
		issueNumber: number
		body: string
	}) {
		requireReadySession()
		applyDriveState(await commentOnIssueFn({ data: withRepositoryRoot(input) }))
	}

	async function editIssueMessage(input: {
		repositoryId: string
		issueNumber: number
		messageId: string
		body: string
	}) {
		requireReadySession()
		applyDriveState(
			await editIssueMessageFn({ data: withRepositoryRoot(input) }),
		)
	}

	async function editIssueTitle(input: {
		repositoryId: string
		issueNumber: number
		title: string
	}) {
		requireReadySession()
		applyDriveState(await editIssueTitleFn({ data: withRepositoryRoot(input) }))
	}

	async function transitionIssue(input: {
		repositoryId: string
		issueNumber: number
		nextIssueState: IssueState
	}) {
		requireReadySession()
		applyDriveState(
			await transitionIssueFn({ data: withRepositoryRoot(input) }),
		)
	}

	async function createPullRequest(input: {
		repositoryId: string
		title: string
		body: string
		files: File[]
	}) {
		requireReadySession()
		setUploadProgress(null)
		try {
			const { createPullRequestFromFolder } = await loadZipWorkflows()
			applyDriveState(
				await createPullRequestFromFolder({
					context: zipWorkflowContext(),
					cache: zipWorkflowCache.current,
					repositoryId: input.repositoryId,
					title: input.title,
					body: input.body,
					files: input.files,
				}),
			)
		} finally {
			setUploadProgress(null)
		}
	}

	async function commentOnPullRequest(input: {
		repositoryId: string
		pullRequestNumber: number
		body: string
	}) {
		requireReadySession()
		applyDriveState(
			await commentOnPullRequestFn({ data: withRepositoryRoot(input) }),
		)
	}

	async function editPullRequestMessage(input: {
		repositoryId: string
		pullRequestNumber: number
		messageId: string
		body: string
	}) {
		requireReadySession()
		applyDriveState(
			await editPullRequestMessageFn({ data: withRepositoryRoot(input) }),
		)
	}

	async function editPullRequestTitle(input: {
		repositoryId: string
		pullRequestNumber: number
		title: string
	}) {
		requireReadySession()
		applyDriveState(
			await editPullRequestTitleFn({ data: withRepositoryRoot(input) }),
		)
	}

	async function reviewPullRequest(
		repositoryId: string,
		pullRequestNumber: number,
	) {
		requireReadySession()
		applyDriveState(
			await reviewPullRequestFn({
				data: withRepositoryRoot({ repositoryId, pullRequestNumber }),
			}),
		)
	}

	async function closePullRequest(
		repositoryId: string,
		pullRequestNumber: number,
	) {
		requireReadySession()
		applyDriveState(
			await closePullRequestFn({
				data: withRepositoryRoot({ repositoryId, pullRequestNumber }),
			}),
		)
	}

	async function mergePullRequest(
		repositoryId: string,
		pullRequestNumber: number,
	) {
		requireReadySession()
		setUploadProgress(null)
		try {
			const { mergePullRequestWithClientZip } = await loadZipWorkflows()
			applyDriveState(
				await mergePullRequestWithClientZip({
					context: zipWorkflowContext(),
					cache: zipWorkflowCache.current,
					repositoryId,
					pullRequestNumber,
				}),
			)
		} finally {
			setUploadProgress(null)
		}
	}

	async function downloadRepositoryZip(repositoryId: string) {
		if (!driveState) throw new Error("Repository state is still loading.")
		const { downloadRepositoryZipFile } = await loadZipWorkflows()
		return await downloadRepositoryZipFile(zipWorkflowContext(), repositoryId)
	}

	async function downloadPullRequestPreviewZip(
		repositoryId: string,
		pullRequestNumber: number,
	) {
		if (!driveState) throw new Error("Repository state is still loading.")
		const { downloadPullRequestPreviewZipFile } = await loadZipWorkflows()
		return await downloadPullRequestPreviewZipFile({
			context: zipWorkflowContext(),
			cache: zipWorkflowCache.current,
			repositoryId,
			pullRequestNumber,
		})
	}

	const value: AppShellState = {
		actor,
		settings: driveState?.settings ?? createDefaultSettings(),
		providerStatus,
		isSigningIn,
		user,
		driveState,
		uploadProgress,
		error,
		loadRepositoryDetail,
		signIn,
		signOut,
		createRepository,
		watchRepository,
		deleteRepository,
		markNotificationsRead,
		updateSettings,
		updateUserName,
		connectBackupDrive,
		connectOwnerDrive,
		disconnectBackupDrive,
		deleteBackupDrive,
		updateRepositoryAccess,
		createIssue,
		commentOnIssue,
		editIssueMessage,
		editIssueTitle,
		transitionIssue,
		createPullRequest,
		commentOnPullRequest,
		editPullRequestMessage,
		editPullRequestTitle,
		reviewPullRequest,
		closePullRequest,
		mergePullRequest,
		downloadPullRequestPreviewZip,
		downloadRepositoryZip,
	}
	return (
		<AppShellContext.Provider value={value}>
			{children}
		</AppShellContext.Provider>
	)
}

export function useAppShell() {
	const value = useContext(AppShellContext)
	if (!value)
		throw new Error("useAppShell must be used inside AppShellProvider.")
	return value
}
