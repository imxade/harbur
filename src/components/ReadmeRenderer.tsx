import "katex/dist/katex.min.css"
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
