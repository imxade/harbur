import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchGitHubRepositorySnapshot } from "../../src/lib/github"

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

describe("GitHub mirror import", () => {
	it("fetches public repository files through GitHub API/raw endpoints instead of codeload ZIPs", async () => {
		const calls: string[] = []
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input)
				calls.push(url)
				if (url === "https://api.github.com/repos/imxade/harbur") {
					return jsonResponse({
						name: "harbur",
						owner: { login: "imxade" },
						default_branch: "master",
						html_url: "https://github.com/imxade/harbur",
					})
				}
				if (url === "https://api.github.com/repos/imxade/harbur/branches/master") {
					return jsonResponse({
						commit: {
							sha: "commit-sha",
							commit: { tree: { sha: "tree-sha" } },
						},
					})
				}
				if (
					url ===
					"https://api.github.com/repos/imxade/harbur/git/trees/tree-sha?recursive=1"
				) {
					return jsonResponse({
						tree: [
							{ path: "src/index.ts", sha: "blob-2", type: "blob" },
							{ path: "README.md", sha: "blob-1", type: "blob" },
						],
					})
				}
				if (
					url ===
						"https://raw.githubusercontent.com/imxade/harbur/commit-sha/README.md" ||
					url ===
						"https://raw.githubusercontent.com/imxade/harbur/commit-sha/src/index.ts"
				) {
					return new Response(
						new TextEncoder().encode(
							url.endsWith("README.md") ? "# Harbur" : "console.log(1)",
						),
					)
				}
				return new Response("unexpected request", { status: 404 })
			}),
		)

		const snapshot = await fetchGitHubRepositorySnapshot(
			"https://github.com/imxade/harbur",
		)

		expect(snapshot.files.map((file) => file.path)).toEqual([
			"README.md",
			"src/index.ts",
		])
		expect(snapshot.files[0]?.content).toBe("# Harbur")
		expect(snapshot.mirror).toMatchObject({
			type: "github",
			owner: "imxade",
			repo: "harbur",
			branch: "master",
			htmlUrl: "https://github.com/imxade/harbur",
		})
		expect(calls.some((url) => url.includes("codeload.github.com"))).toBe(
			false,
		)
		expect(calls.some((url) => url.includes("raw.githubusercontent.com"))).toBe(
			true,
		)
	})

	it("falls back to the Git blob API when raw file fetches fail", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input)
				if (url === "https://api.github.com/repos/imxade/harbur") {
					return jsonResponse({
						name: "harbur",
						owner: { login: "imxade" },
						default_branch: "main",
						html_url: "https://github.com/imxade/harbur",
					})
				}
				if (url === "https://api.github.com/repos/imxade/harbur/branches/main") {
					return jsonResponse({
						commit: {
							sha: "commit-sha",
							commit: { tree: { sha: "tree-sha" } },
						},
					})
				}
				if (
					url ===
					"https://api.github.com/repos/imxade/harbur/git/trees/tree-sha?recursive=1"
				) {
					return jsonResponse({
						tree: [{ path: "README.md", sha: "blob-1", type: "blob" }],
					})
				}
				if (
					url ===
					"https://raw.githubusercontent.com/imxade/harbur/commit-sha/README.md"
				) {
					return new Response("raw unavailable", { status: 404 })
				}
				if (url === "https://api.github.com/repos/imxade/harbur/git/blobs/blob-1") {
					return jsonResponse({
						content: "RmFsbGJhY2sK",
						encoding: "base64",
					})
				}
				return new Response("unexpected request", { status: 404 })
			}),
		)

		const snapshot = await fetchGitHubRepositorySnapshot(
			"https://github.com/imxade/harbur",
		)

		expect(snapshot.files).toHaveLength(1)
		expect(snapshot.files[0]?.path).toBe("README.md")
		expect(snapshot.files[0]?.content).toBe("Fallback\n")
	})
})

function jsonResponse(body: unknown) {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
	})
}
