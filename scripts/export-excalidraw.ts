import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { JSDOM } from "jsdom"

type ExcalidrawScene = {
	type?: string
	elements?: unknown[]
	appState?: Record<string, unknown>
	files?: Record<string, unknown>
}

type ExportToSvg = (opts: {
	elements: readonly unknown[]
	appState?: Record<string, unknown>
	files: Record<string, unknown>
	exportPadding?: number
	skipInliningFonts?: true
}) => Promise<SVGSVGElement>

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const assetsDir = path.join(rootDir, "assets")
const ignoredDirectories = new Set([
	".git",
	"node_modules",
	"dist",
	".output",
	".vercel",
])

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
	pretendToBeVisual: true,
	url: "http://localhost/",
})

Object.defineProperties(globalThis, {
	window: { value: dom.window, configurable: true },
	document: { value: dom.window.document, configurable: true },
	navigator: { value: dom.window.navigator, configurable: true },
	HTMLElement: { value: dom.window.HTMLElement, configurable: true },
	HTMLCanvasElement: { value: dom.window.HTMLCanvasElement, configurable: true },
	SVGElement: { value: dom.window.SVGElement, configurable: true },
	SVGSVGElement: { value: dom.window.SVGSVGElement, configurable: true },
	Blob: { value: dom.window.Blob, configurable: true },
	FileReader: { value: dom.window.FileReader, configurable: true },
	DOMParser: { value: dom.window.DOMParser, configurable: true },
	XMLSerializer: { value: dom.window.XMLSerializer, configurable: true },
	devicePixelRatio: { value: 1, configurable: true },
	location: { value: dom.window.location, configurable: true },
	ResizeObserver: {
		value: class ResizeObserver {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		configurable: true,
	},
})

const { exportToSvg } = (await import("@excalidraw/utils")) as {
	exportToSvg: ExportToSvg
}

async function findExcalidrawFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true })
	const files: string[] = []

	for (const entry of entries) {
		const entryPath = path.join(directory, entry.name)

		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) {
				files.push(...(await findExcalidrawFiles(entryPath)))
			}
			continue
		}

		if (entry.isFile() && entry.name.endsWith(".excalidraw")) {
			files.push(entryPath)
		}
	}

	return files
}

const scenePaths = await findExcalidrawFiles(rootDir)

if (scenePaths.length === 0) {
	console.log("No .excalidraw files found.")
	process.exit(0)
}

await mkdir(assetsDir, { recursive: true })

const outputNames = new Set<string>()

for (const scenePath of scenePaths) {
	const outputName = `${path.basename(scenePath, ".excalidraw")}.svg`

	if (outputNames.has(outputName)) {
		throw new Error(
			`Multiple Excalidraw files would export to assets/${outputName}. Rename one source file.`,
		)
	}

	outputNames.add(outputName)

	const scene = JSON.parse(await readFile(scenePath, "utf8")) as ExcalidrawScene

	if (!Array.isArray(scene.elements)) {
		throw new Error(`${path.relative(rootDir, scenePath)} is missing an elements array.`)
	}

	const svg = await exportToSvg({
		elements: scene.elements,
		appState: {
			exportBackground: true,
			viewBackgroundColor: "#ffffff",
			...scene.appState,
		},
		files: scene.files ?? {},
		skipInliningFonts: true,
	})

	const outputPath = path.join(assetsDir, outputName)
	await writeFile(outputPath, `${svg.outerHTML}\n`)

	console.log(
		`${path.relative(rootDir, scenePath)} -> ${path.relative(rootDir, outputPath)}`,
	)
}
