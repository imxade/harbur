import { Link } from "@tanstack/react-router"
import { Bell, Github, LogOut, Moon, Settings, Sun } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { APP_GITHUB_URL, APP_NAME } from "../lib/app-config"
import type { AppState } from "../lib/drive-state"
import { displayOwnerName, replaceEmailsWithOwnerNames } from "../lib/users"
import { useAppShell } from "./AppShellProvider"
import DriveStorageIndicator from "./DriveStorageIndicator"

const THEME_STORAGE_KEY = `${APP_NAME}-theme`
const THEME_NAMES = ["cupcake", "dracula"] as const

type ThemeName = (typeof THEME_NAMES)[number]

function readTheme(): ThemeName {
	if (typeof document === "undefined") return "dracula"
	const theme = document.documentElement.getAttribute("data-theme")
	return THEME_NAMES.includes(theme as ThemeName)
		? (theme as ThemeName)
		: "dracula"
}

export default function Header() {
	const {
		actor,
		driveState,
		isSigningIn,
		providerStatus,
		signIn,
		signOut,
		markNotificationsRead,
		user,
	} = useAppShell()
	const [theme, setTheme] = useState<ThemeName>("dracula")
	const [notificationsOpen, setNotificationsOpen] = useState(false)
	const notificationsRef = useRef<HTMLDetailsElement | null>(null)
	const ownerName = user
		? displayOwnerName(user.email, driveState?.users ?? {})
		: undefined
	const unreadNotifications = user
		? (driveState?.notifications[user.email.toLowerCase()] ?? []).some(
				(notification) => !notification.read,
			)
		: false
	const notificationItems =
		user && driveState
			? buildNotificationItems(user.email, driveState).slice(0, 10)
			: []
	const nextTheme = theme === "dracula" ? "cupcake" : "dracula"

	useEffect(() => {
		setTheme(readTheme())
	}, [])

	useEffect(() => {
		if (!notificationsOpen) return
		function closeOnOutsideClick(event: PointerEvent) {
			const target = event.target
			if (
				target instanceof Node &&
				notificationsRef.current?.contains(target)
			) {
				return
			}
			setNotificationsOpen(false)
		}
		document.addEventListener("pointerdown", closeOnOutsideClick)
		return () => {
			document.removeEventListener("pointerdown", closeOnOutsideClick)
		}
	}, [notificationsOpen])

	function toggleTheme() {
		document.documentElement.setAttribute("data-theme", nextTheme)
		localStorage.setItem(THEME_STORAGE_KEY, nextTheme)
		setTheme(nextTheme)
	}

	return (
		<header className="navbar sticky top-0 z-40 min-h-14 bg-base-100 border-b border-base-300 px-2 sm:px-4">
			<div className="navbar-start min-w-0 flex-1">
				<Link to="/" className="btn btn-ghost px-2 text-lg sm:text-xl">
					{APP_NAME}
				</Link>
			</div>
			<div className="navbar-end shrink-0 gap-1 sm:gap-2">
				{user ? (
					<div className="hidden sm:flex flex-col items-end leading-tight">
						<span className="text-sm font-medium">{ownerName}</span>
						<span className="text-xs text-base-content/60">{actor.role}</span>
					</div>
				) : null}
				{actor.role === "admin" ? (
					<DriveStorageIndicator state={driveState} />
				) : null}
				<details
					ref={notificationsRef}
					className="dropdown dropdown-end"
					open={notificationsOpen}
					onToggle={(event) => setNotificationsOpen(event.currentTarget.open)}
				>
					<summary
						className={
							unreadNotifications
								? "btn btn-secondary btn-square btn-sm relative list-none [&::-webkit-details-marker]:hidden"
								: "btn btn-ghost btn-square btn-sm relative list-none [&::-webkit-details-marker]:hidden"
						}
						aria-label={
							unreadNotifications
								? "Notifications, unread items"
								: "Notifications"
						}
					>
						<Bell size={18} />
						{unreadNotifications ? (
							<span className="badge badge-primary badge-xs absolute -right-1 -top-1" />
						) : null}
					</summary>
					<div className="dropdown-content z-50 mt-2 w-80 max-w-[calc(100vw-1rem)] rounded-lg border border-base-300 bg-base-100 p-2 shadow-xl">
						{notificationItems.length ? (
							<div className="max-h-96 overflow-y-auto">
								{notificationItems.map((item) => (
									<a
										key={item.id}
										href={item.href}
										className={
											item.unread
												? "block rounded-md bg-primary/10 p-3 hover:bg-primary/20"
												: "block rounded-md p-3 hover:bg-base-200"
										}
										onClick={() => {
											setNotificationsOpen(false)
											void markNotificationsRead()
										}}
									>
										<p className="break-words text-sm">{item.message}</p>
										<p className="mt-1 text-xs text-base-content/50">
											{new Date(item.createdAt).toLocaleString()}
										</p>
									</a>
								))}
							</div>
						) : (
							<div className="p-3 text-sm text-base-content/60">
								No notifications yet.
							</div>
						)}
					</div>
				</details>
				<button
					type="button"
					className="btn btn-ghost btn-square btn-sm"
					onClick={toggleTheme}
					aria-label={`Switch to ${nextTheme} theme`}
					title={`Switch to ${nextTheme} theme`}
				>
					{theme === "dracula" ? <Sun size={18} /> : <Moon size={18} />}
				</button>
				<a
					href={APP_GITHUB_URL}
					target="_blank"
					rel="noreferrer"
					className="btn btn-ghost btn-square btn-sm"
					aria-label="GitHub repository"
					title="GitHub repository"
				>
					<Github size={18} />
				</a>
				<Link
					to="/settings"
					className="btn btn-ghost btn-square btn-sm"
					aria-label="Settings"
				>
					<Settings size={18} />
				</Link>
				{user ? (
					<button
						type="button"
						className="btn btn-ghost btn-square btn-sm"
						onClick={() => void signOut()}
						aria-label="Sign out"
					>
						<LogOut size={18} />
					</button>
				) : (
					<button
						type="button"
						className="btn btn-primary btn-sm px-3"
						onClick={() => void signIn()}
						disabled={isSigningIn || providerStatus === "not-configured"}
					>
						{isSigningIn
							? "Signing in"
							: providerStatus === "loading"
								? "Loading"
								: "Sign in"}
					</button>
				)}
			</div>
		</header>
	)
}

function buildNotificationItems(email: string, driveState: AppState) {
	const actorEmail = email.toLowerCase()
	const watched = new Set(driveState.watches[actorEmail] ?? [])
	const users = driveState.users
	const mentionItems =
		driveState.notifications[actorEmail]?.map((notification) => ({
			id: notification.id,
			repositoryId: notification.repositoryId,
			sourceId: notification.sourceId,
			message: replaceEmailsWithOwnerNames(notification.message, users),
			createdAt: notification.createdAt,
			unread: !notification.read,
		})) ?? []
	const activityItems = driveState.activity
		.filter((record) => watched.has(record.repositoryId))
		.filter((record) => record.kind !== "repo.watched")
		.map((record) => ({
			id: record.id,
			repositoryId: record.repositoryId,
			sourceId: undefined,
			message: replaceEmailsWithOwnerNames(record.message, users),
			createdAt: record.timestamp,
			unread: false,
		}))
	return [...mentionItems, ...activityItems]
		.map((item) => ({
			...item,
			href: notificationHref(
				item.repositoryId,
				item.message,
				driveState,
				item.sourceId,
			),
		}))
		.sort(
			(left, right) =>
				new Date(right.createdAt).getTime() -
				new Date(left.createdAt).getTime(),
		)
}

function notificationHref(
	repositoryId: string,
	message: string,
	driveState: AppState,
	sourceId?: string,
) {
	const repository = driveState.repositories.find(
		(candidate) => candidate.id === repositoryId,
	)
	if (!repository) return "/"
	const base = `/repo/${repository.owner}/${repository.name}`
	if (sourceId) {
		const sourceIssue = (driveState.issues[repositoryId] ?? []).find(
			(issue) =>
				sourceId.startsWith(issue.id) ||
				issue.comments.some((comment) => sourceId.startsWith(comment.id)),
		)
		if (sourceIssue) return `${base}/issues/${sourceIssue.number}`
		const sourcePullRequest = (
			driveState.pullRequests[repositoryId] ?? []
		).find(
			(pullRequest) =>
				sourceId.startsWith(pullRequest.id) ||
				pullRequest.comments.some((comment) => sourceId.startsWith(comment.id)),
		)
		if (sourcePullRequest) return `${base}/pulls/${sourcePullRequest.number}`
	}
	const issue = message.match(/issue #(\d+)/i)?.[1]
	if (issue) return `${base}/issues/${issue}`
	const pullRequest = message.match(/\b(?:pr|pull request) #(\d+)/i)?.[1]
	if (pullRequest) return `${base}/pulls/${pullRequest}`
	return base
}
