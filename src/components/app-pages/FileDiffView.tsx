import { structuredPatch } from "diff"
import { useMemo, useState } from "react"
import { repositoryFileText } from "../../lib/repositories"

export function FileDiffView({
	diff,
	before,
	after,
}: {
	diff: {
		path: string
		status: string
		beforeHash?: string
		afterHash?: string
	}
	before?: { content: string | Uint8Array; encoding?: "utf8" | "base64" }
	after?: { content: string | Uint8Array; encoding?: "utf8" | "base64" }
}) {
	const [hidden, setHidden] = useState(true)
	const lines = useMemo(
		() =>
			hidden
				? []
				: missingDiffContent(diff.status, before, after)
					? [{ kind: "same" as const, text: "File content not loaded." }]
					: buildLineDiff(before, after),
		[after, before, diff.status, hidden],
	)
	return (
		<section className="rounded-lg border border-base-300 bg-base-100 overflow-hidden">
			<header className="flex flex-col gap-2 border-b border-base-300 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-2">
						<span className={diffStatusClass(diff.status)}>{diff.status}</span>
						<span className="font-mono text-sm break-all">{diff.path}</span>
					</div>
					<p className="text-xs text-base-content/50">
						{diff.beforeHash ?? "-"} → {diff.afterHash ?? "-"}
					</p>
				</div>
				<button
					type="button"
					className="btn btn-outline btn-xs w-full sm:w-auto"
					onClick={() => setHidden((current) => !current)}
				>
					{hidden ? "Show diff" : "Hide diff"}
				</button>
			</header>
			{hidden ? null : (
				<div className="overflow-x-auto bg-base-200/50">
					<pre className="min-w-full py-2 text-xs leading-5">
						{lines.map((line, index) => (
							<div
								key={`${line.kind}:${index}:${line.text}`}
								className={lineDiffClass(line.kind)}
							>
								<span className="inline-block w-12 select-none pr-2 text-right text-base-content/40">
									{line.oldLineNumber ?? ""}
								</span>
								<span className="inline-block w-12 select-none pr-2 text-right text-base-content/40">
									{line.newLineNumber ?? ""}
								</span>
								<span className="inline-block w-6 select-none text-center text-base-content/50">
									{line.kind === "hunk"
										? ""
										: line.kind === "add"
											? "+"
											: line.kind === "remove"
												? "-"
												: " "}
								</span>
								<span className="px-3 font-mono whitespace-pre-wrap">
									{line.hunkHeader ?? (line.text || " ")}
								</span>
							</div>
						))}
					</pre>
				</div>
			)}
		</section>
	)
}

type DiffLine = {
	kind: "add" | "remove" | "same" | "hunk"
	text: string
	oldLineNumber?: number
	newLineNumber?: number
	hunkHeader?: string
}

function buildLineDiff(
	before:
		| { content: string | Uint8Array; encoding?: "utf8" | "base64" }
		| undefined,
	after:
		| { content: string | Uint8Array; encoding?: "utf8" | "base64" }
		| undefined,
): DiffLine[] {
	const beforeText = contentToText(before)
	const afterText = contentToText(after)
	if (beforeText === null || afterText === null) {
		return [{ kind: "same", text: "Binary file changed." }]
	}
	if (
		beforeText.length + afterText.length > 2 * 1024 * 1024 ||
		countLines(beforeText) + countLines(afterText) > 50_000
	) {
		return [{ kind: "same", text: "Text diff is too large to render safely." }]
	}
	return structuredPatch(
		"before",
		"after",
		beforeText,
		afterText,
		undefined,
		undefined,
		{
			context: 3,
		},
	).hunks.flatMap((hunk) => {
		let oldLineNumber = hunk.oldStart
		let newLineNumber = hunk.newStart
		const lines: DiffLine[] = [
			{
				kind: "hunk",
				text: "",
				hunkHeader: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
			},
		]
		for (const rawLine of hunk.lines) {
			if (rawLine.startsWith("\\")) continue
			const marker = rawLine[0]
			const text = rawLine.slice(1)
			if (marker === "+") {
				lines.push({ kind: "add", text, newLineNumber })
				newLineNumber += 1
			} else if (marker === "-") {
				lines.push({ kind: "remove", text, oldLineNumber })
				oldLineNumber += 1
			} else {
				lines.push({
					kind: "same",
					text,
					oldLineNumber,
					newLineNumber,
				})
				oldLineNumber += 1
				newLineNumber += 1
			}
		}
		return lines
	})
}

function countLines(value: string) {
	let lines = 1
	for (let index = 0; index < value.length; index += 1) {
		if (value.charCodeAt(index) === 10) lines += 1
	}
	return lines
}

function missingDiffContent(
	status: string,
	before:
		| { content: string | Uint8Array; encoding?: "utf8" | "base64" }
		| undefined,
	after:
		| { content: string | Uint8Array; encoding?: "utf8" | "base64" }
		| undefined,
) {
	if (status === "added") return !after
	if (status === "deleted") return !before
	if (status === "modified") return !before || !after
	return false
}

function contentToText(
	file:
		| { content: string | Uint8Array; encoding?: "utf8" | "base64" }
		| undefined,
) {
	return repositoryFileText(file)
}

function diffStatusClass(status: string) {
	if (status === "added") return "badge badge-success"
	if (status === "deleted") return "badge badge-error"
	if (status === "modified") return "badge badge-warning"
	return "badge badge-outline"
}

function lineDiffClass(kind: DiffLine["kind"]) {
	if (kind === "add") return "bg-success/20 text-success-content"
	if (kind === "remove") return "bg-error/20 text-error-content"
	if (kind === "hunk") return "bg-base-300 text-base-content/60"
	return "text-base-content/80"
}
