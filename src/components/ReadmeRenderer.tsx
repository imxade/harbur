import "katex/dist/katex.min.css"
import { useEffect, useId, useRef } from "react"
import ReactMarkdown from "react-markdown"
import rehypeKatex from "rehype-katex"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import { normalizeReadmeAssetPath } from "../lib/readme-assets"

export default function ReadmeRenderer({
	markdown,
	assetUrls = {},
}: {
	markdown: string
	assetUrls?: Record<string, string>
}) {
	return (
		<article className="prose prose-invert max-w-none overflow-x-auto rounded-lg border border-base-300 bg-base-100 p-4 sm:p-6 [&_img]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:overflow-x-auto">
			<ReactMarkdown
				remarkPlugins={[remarkGfm, remarkMath]}
				rehypePlugins={[rehypeKatex]}
				components={{
					code({ className, children, ...props }) {
						const source = String(children).replace(/\n$/, "")
						if (className?.split(" ").includes("language-mermaid")) {
							return <MermaidBlock source={source} />
						}
						return (
							<code className={className} {...props}>
								{children}
							</code>
						)
					},
					img({ src = "", alt = "", ...props }) {
						return (
							<img
								src={readmeImageSrc(src, assetUrls)}
								alt={alt}
								loading="lazy"
								{...props}
							/>
						)
					},
				}}
			>
				{markdown}
			</ReactMarkdown>
		</article>
	)
}

function readmeImageSrc(src: string, assetUrls: Record<string, string>) {
	const assetPath = normalizeReadmeAssetPath(src)
	return assetPath ? (assetUrls[assetPath] ?? src) : src
}

function MermaidBlock({ source }: { source: string }) {
	const id = useId().replaceAll(":", "")
	const ref = useRef<HTMLDivElement | null>(null)
	const normalizedSource = source.trim()

	useEffect(() => {
		let cancelled = false
		async function renderDiagram() {
			if (!ref.current || !normalizedSource) return
			try {
				const { default: mermaid } = await import("mermaid")
				mermaid.initialize({
					startOnLoad: false,
					securityLevel: "strict",
					theme: "dark",
				})
				const result = await mermaid.render(`mermaid-${id}`, normalizedSource)
				if (!cancelled && ref.current) {
					ref.current.innerHTML = result.svg
				}
			} catch (cause) {
				if (!cancelled && ref.current) {
					ref.current.textContent =
						cause instanceof Error ? cause.message : "Mermaid render failed."
				}
			}
		}
		void renderDiagram()
		return () => {
			cancelled = true
		}
	}, [id, normalizedSource])

	return (
		<div
			ref={ref}
			className="not-prose overflow-x-auto rounded bg-base-200 p-4"
		/>
	)
}
