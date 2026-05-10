import { Fragment, type ReactNode } from "react"

const URL_PATTERN = /https?:\/\/[^\s<>"']+/g
const TRAILING_URL_PUNCTUATION = /[),.;:!?]+$/

export function LinkifiedText({
	text,
	className,
	linkClassName = "link link-primary",
	renderText = defaultRenderText,
}: {
	text: string
	className?: string
	linkClassName?: string
	renderText?: (text: string, key: string) => ReactNode
}) {
	const parts: ReactNode[] = []
	let lastIndex = 0

	for (const match of text.matchAll(URL_PATTERN)) {
		const rawUrl = match[0]
		const index = match.index ?? 0
		const trailing = rawUrl.match(TRAILING_URL_PUNCTUATION)?.[0] ?? ""
		const url = trailing ? rawUrl.slice(0, -trailing.length) : rawUrl
		if (index > lastIndex) {
			parts.push(renderText(text.slice(lastIndex, index), `text:${lastIndex}`))
		}
		parts.push(
			<a
				key={`${url}:${index}`}
				className={linkClassName}
				href={url}
				target="_blank"
				rel="noreferrer"
			>
				{url}
			</a>,
		)
		if (trailing) {
			parts.push(<Fragment key={`trailing:${index}`}>{trailing}</Fragment>)
		}
		lastIndex = index + rawUrl.length
	}

	if (lastIndex < text.length) {
		parts.push(renderText(text.slice(lastIndex), `text:${lastIndex}`))
	}

	const content = <>{parts}</>
	return className ? <span className={className}>{content}</span> : content
}

function defaultRenderText(text: string, key: string) {
	return <Fragment key={key}>{text}</Fragment>
}
