import ReadmeRenderer from "../ReadmeRenderer"
import { readmeAssetUrls } from "../../lib/readme-assets"

export function OverviewPanel({
	files,
}: {
	files: Array<{
		path: string
		content: string | Uint8Array
		encoding?: "utf8" | "base64"
	}>
}) {
	const readme = files.find((file) => file.path.toLowerCase() === "readme.md")
	const markdown =
		typeof readme?.content === "string"
			? readme.content
			: "# README not found\n\nThis repository does not include a root README.md file."
	return (
		<div className="min-w-0">
			<ReadmeRenderer markdown={markdown} assetUrls={readmeAssetUrls(files)} />
		</div>
	)
}
