import { Pencil, Save, X } from "lucide-react"
import { useEffect, useState } from "react"
import type { FormEvent, ReactNode } from "react"
import { isAnonymousEmail } from "../../lib/auth"
import { LinkifiedText } from "../LinkifiedText"

function RichText({
	text,
	actorEmail,
	users,
}: {
	text: string
	actorEmail: string
	users: Record<string, { ownerName: string }>
}) {
	return (
		<LinkifiedText
			text={text}
			renderText={(value, key) => (
				<HighlightedMentions
					key={key}
					text={value}
					actorEmail={actorEmail}
					users={users}
				/>
			)}
		/>
	)
}

function HighlightedMentions({
	text,
	actorEmail,
	users,
}: {
	text: string
	actorEmail: string
	users: Record<string, { ownerName: string }>
}) {
	const aliases = Object.entries(users)
		.flatMap(([email, user]) =>
			mentionAliases(user.ownerName).map((alias) => ({ alias, email })),
		)
		.sort((left, right) => right.alias.length - left.alias.length)
	if (!aliases.length) return <>{text}</>
	const pattern = new RegExp(
		`@(${aliases.map((entry) => escapeRegExp(entry.alias)).join("|")})(?![\\w.-])`,
		"gi",
	)
	const parts: ReactNode[] = []
	let lastIndex = 0
	for (const match of text.matchAll(pattern)) {
		const index = match.index ?? 0
		const value = match[0]
		const alias = match[1]?.toLowerCase()
		const email = aliases.find(
			(entry) => entry.alias.toLowerCase() === alias,
		)?.email
		if (index > lastIndex) parts.push(text.slice(lastIndex, index))
		parts.push(
			<span
				key={`${value}:${index}`}
				className={
					email?.toLowerCase() === actorEmail.toLowerCase()
						? "rounded bg-primary px-1 font-semibold text-primary-content"
						: "rounded bg-base-300 px-1 font-medium text-base-content"
				}
			>
				{value}
			</span>,
		)
		lastIndex = index + value.length
	}
	if (lastIndex < text.length) parts.push(text.slice(lastIndex))
	return <>{parts}</>
}

function mentionAliases(ownerName: string) {
	const trimmed = ownerName.trim()
	return [...new Set([trimmed, trimmed.replace(/\s+/g, "-")].filter(Boolean))]
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export type ChatTimelineMessage = {
	id: string
	authorEmail: string
	body: string
	createdAt: string
	updatedAt?: string
	editedAt?: string
	persistenceStatus?: "sending" | "stored" | "failed"
}

export function ChatTimeline({
	actorEmail,
	messages,
	ownerForEmail,
	users,
	onEditMessage,
	onError,
}: {
	actorEmail: string
	messages: ChatTimelineMessage[]
	ownerForEmail: (email: string) => string
	users: Record<string, { ownerName: string }>
	onEditMessage: (messageId: string, body: string) => Promise<void>
	onError: (message: string) => void
}) {
	const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
	const [editingBody, setEditingBody] = useState("")
	const [busy, setBusy] = useState(false)
	const canEditMessage = (message: ChatTimelineMessage) =>
		!isAnonymousEmail(actorEmail) &&
		!message.persistenceStatus &&
		message.authorEmail.toLowerCase() === actorEmail.toLowerCase()

	async function submitMessageEdit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (!editingMessageId) return
		setBusy(true)
		onError("")
		try {
			await onEditMessage(editingMessageId, editingBody)
			setEditingMessageId(null)
			setEditingBody("")
		} catch (cause) {
			onError(cause instanceof Error ? cause.message : "Message edit failed.")
		} finally {
			setBusy(false)
		}
	}

	return (
		<div className="space-y-3">
			{messages.map((message) => (
				<div
					key={message.id}
					className={
						message.authorEmail.toLowerCase() === actorEmail.toLowerCase()
							? "chat chat-end"
							: "chat chat-start"
					}
				>
					<div className="chat-header break-words text-xs text-base-content/60">
						{ownerForEmail(message.authorEmail)} ·{" "}
						{new Date(message.createdAt).toLocaleString()}
						{message.editedAt ? (
							<span>
								{" "}
								· edited {new Date(message.editedAt).toLocaleString()}
							</span>
						) : null}
					</div>
					<div className="chat-bubble max-w-full whitespace-pre-wrap break-words">
						{editingMessageId === message.id ? (
							<form
								className="grid gap-2"
								onSubmit={(event) => void submitMessageEdit(event)}
							>
								<textarea
									className="textarea textarea-bordered min-h-24 w-full text-base-content"
									value={editingBody}
									onChange={(event) => setEditingBody(event.target.value)}
									required
								/>
								<div className="flex flex-wrap gap-2">
									<button
										type="submit"
										className="btn btn-primary btn-xs"
										disabled={busy}
									>
										<Save size={14} /> Save
									</button>
									<button
										type="button"
										className="btn btn-ghost btn-xs"
										onClick={() => {
											setEditingMessageId(null)
											setEditingBody("")
										}}
									>
										<X size={14} /> Cancel
									</button>
								</div>
							</form>
						) : (
							<RichText
								text={message.body}
								actorEmail={actorEmail}
								users={users}
							/>
						)}
					</div>
					{message.persistenceStatus || canEditMessage(message) ? (
						<div className="chat-footer mt-1 flex items-center gap-2">
							{message.persistenceStatus ? (
								<span
									className={
										message.persistenceStatus === "failed"
											? "text-error"
											: "text-base-content/60"
									}
									aria-live="polite"
								>
									{message.persistenceStatus === "sending"
										? "Sending…"
										: message.persistenceStatus === "stored"
											? "Stored · visible to others"
											: "Not stored · visible only to you"}
								</span>
							) : null}
							{canEditMessage(message) ? (
								<button
									type="button"
									className="btn btn-ghost btn-xs"
									onClick={() => {
										setEditingMessageId(message.id)
										setEditingBody(message.body)
									}}
								>
									<Pencil size={12} /> Edit
								</button>
							) : null}
						</div>
					) : null}
				</div>
			))}
		</div>
	)
}

export function EditableThreadTitle({
	actorEmail,
	canEdit,
	number,
	title,
	onEditTitle,
}: {
	actorEmail: string
	canEdit: boolean
	number: number
	title: string
	onEditTitle: (title: string) => Promise<void>
}) {
	const [isEditing, setIsEditing] = useState(false)
	const [draft, setDraft] = useState(title)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const canEditTitle = !isAnonymousEmail(actorEmail) && canEdit

	useEffect(() => {
		setDraft(title)
	}, [title])

	async function submitTitle(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		setBusy(true)
		setError(null)
		try {
			await onEditTitle(draft)
			setIsEditing(false)
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Title edit failed.")
		} finally {
			setBusy(false)
		}
	}

	if (isEditing) {
		return (
			<form
				className="grid gap-2"
				onSubmit={(event) => void submitTitle(event)}
			>
				<div className="flex flex-col gap-2 sm:flex-row">
					<input
						className="input input-bordered w-full text-xl font-bold sm:text-2xl"
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
						required
					/>
					<div className="flex gap-2">
						<button type="submit" className="btn btn-primary" disabled={busy}>
							<Save size={16} /> Save
						</button>
						<button
							type="button"
							className="btn btn-ghost"
							onClick={() => {
								setDraft(title)
								setIsEditing(false)
							}}
						>
							<X size={16} /> Cancel
						</button>
					</div>
				</div>
				{error ? <div className="alert alert-error">{error}</div> : null}
			</form>
		)
	}

	return (
		<div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
			<h2 className="break-words text-xl font-bold sm:text-2xl">
				{title} <span className="text-base-content/50">#{number}</span>
			</h2>
			{canEditTitle ? (
				<button
					type="button"
					className="btn btn-ghost btn-sm"
					onClick={() => setIsEditing(true)}
				>
					<Pencil size={14} /> Edit title
				</button>
			) : null}
		</div>
	)
}
