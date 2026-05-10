import { afterEach, describe, expect, it, vi } from "vitest"
import {
	APP_DOWNLOAD,
	APP_SLUG,
	APP_TIMING,
	GOOGLE_DRIVE_API,
} from "../../src/lib/app-config"
import {
	canMaintainRepository,
	canOwnRepository,
	isAdminEmail,
} from "../../src/lib/auth"
import {
	downloadRepositoryZipFile,
	type ClientZipWorkflowContext,
} from "../../src/lib/client-zip-workflows"
import { transitionIssueState, type IssueRecord } from "../../src/lib/issues"
import { resolveMentionedUsers, type AppState } from "../../src/lib/drive-state"
import { googleDrivePublicFileMediaUrl } from "../../src/lib/google-drive"
import {
	applyPullRequestFiles,
	compactPullRequestChanges,
	diffRepositoryFiles,
	assertCanMergePullRequest,
	type PullRequestRecord,
} from "../../src/lib/pulls"
import {
	assertRepositoryName,
	createRepositoryManifest,
	filesForDownload,
} from "../../src/lib/repositories"
import { prepareRepositoryUploadFiles } from "../../src/lib/repositories/uploads"
import { isBlockedVcsPath, isUnsafePath } from "../../src/lib/security/paths"
import {
	inferRepositoryNameFromGitHubUrl,
	rankRepositoriesByQuery,
	toRepositorySummary,
} from "../../src/lib/search"
import { createDefaultSettings } from "../../src/lib/settings"
import {
	repositoryPolicySchema,
	type Actor,
	type RepositoryFile,
} from "../../src/lib/types"
import {
	prepareClientUploadArchive,
	summarizeClientUploadFiles,
} from "../../src/lib/upload-client"
import { unzipBlob } from "../../src/lib/zip"

const files: RepositoryFile[] = [
	{ path: "README.md", content: "hello", size: 5 },
	{ path: "src/index.ts", content: "console.log(1)", size: 14 },
]

function repo() {
	return createRepositoryManifest({
		owner: APP_SLUG,
		name: "demo",
		rootFolderId: "drive-folder",
		files,
		now: "2026-05-05T00:00:00.000Z",
	})
}

function zipDownloadContext(
	revokeZipDownload = vi.fn(async () => undefined),
	cleanupDelayMs = APP_DOWNLOAD.cleanupDelayMs,
): ClientZipWorkflowContext {
	const unused = async () => {
		throw new Error("unused")
	}
	return {
		getState: () =>
			({
				settings: {
					...createDefaultSettings(),
					downloadCleanupDelayMs: cleanupDelayMs,
				},
			}) as AppState,
		setState: () => undefined,
		setProgress: () => undefined,
		getRepositoryRootFolderId: () => "repo-root-folder",
		getOrigin: () => "http://localhost:3000",
		beginZipUpload: unused,
		cancelZipUpload: unused,
		revokeZipDownload,
		completeRepositoryUpload: unused,
		completePullRequestUpload: unused,
		completePullRequestMergeUpload: unused,
		completeGitHubMirrorSyncUpload: unused,
		downloadRepositoryZip: async () => ({
			name: "demo.zip",
			fetchUrl: "https://www.googleapis.com/drive/v3/files/temp?alt=media",
			downloadTicket: "signed-cleanup-ticket",
		}),
		downloadPullRequestZip: unused,
	}
}

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
})

describe("settings and auth", () => {
	it("defaults repository creation policy conservatively", () => {
		const settings = createDefaultSettings()
		expect(settings.allowPublicGitMirrors).toBe(false)
		expect(settings.githubMirrorSyncIntervalHours).toBe(24)
		expect(settings.defaultRepoVisibility).toBe("public")
		expect(settings.defaultRepoPolicy).toEqual({
			issuesEnabled: true,
			prsEnabled: true,
			allowUserCloseOwnIssues: true,
			requiredStatusForMerge: "none",
		})
		expect(settings.prAutoCleanDays).toBe(0)
		expect(settings.backupSyncIntervalHours).toBe(24)
		expect(settings.downloadCleanupDelayMs).toBe(APP_DOWNLOAD.cleanupDelayMs)
	})

	it("keeps repository policy schema limited to enforced controls", () => {
		expect(
			repositoryPolicySchema.parse({
				issuesEnabled: true,
				prsEnabled: true,
				allowUserCloseOwnIssues: true,
				requiredStatusForMerge: "none",
				allowUserCloseOwnPrs: true,
				maintainerCanEditDocs: true,
			}),
		).toEqual({
			issuesEnabled: true,
			prsEnabled: true,
			allowUserCloseOwnIssues: true,
			requiredStatusForMerge: "none",
		})
	})

	it("matches admin allowlist exactly after normalization", () => {
		expect(isAdminEmail(" Admin@Example.com ", "admin@example.com")).toBe(true)
		expect(isAdminEmail("notadmin@example.com", "admin@example.com")).toBe(
			false,
		)
		expect(isAdminEmail("ops@example.com.evil", "ops@example.com")).toBe(false)
	})
})

describe("repository safety", () => {
	it("blocks VCS metadata and unsafe traversal", () => {
		expect(isBlockedVcsPath("src/.git/config")).toBe(true)
		expect(isBlockedVcsPath("_FOSSIL_")).toBe(true)
		expect(isUnsafePath("../secret")).toBe(true)
	})

	it("excludes app metadata from downloads", () => {
		const result = filesForDownload([
			...files,
			{ path: "issues/1.json", content: "{}", size: 2 },
			{ path: ".git/config", content: "", size: 0 },
		])
		expect(result.map((file) => file.path)).toEqual([
			"README.md",
			"src/index.ts",
		])
	})

	it("rejects spaces and special characters in repository names", () => {
		expect(() => assertRepositoryName("demo-repo_1.2")).not.toThrow()
		expect(() => assertRepositoryName("demo repo")).toThrow("Repository names")
		expect(() => assertRepositoryName("@demo")).toThrow("Repository names")
		expect(() => assertRepositoryName("-demo")).toThrow("Repository names")
	})

	it("stores GitHub mirror metadata and infers repository names", () => {
		expect(
			inferRepositoryNameFromGitHubUrl(
				`https://github.com/imxade/${APP_SLUG}.git`,
			),
		).toBe(APP_SLUG)
		const repository = createRepositoryManifest({
			owner: APP_SLUG,
			name: "mirror",
			rootFolderId: "drive-folder",
			files,
			githubMirror: {
				type: "github",
				owner: "imxade",
				repo: APP_SLUG,
				branch: "main",
				htmlUrl: `https://github.com/imxade/${APP_SLUG}`,
				zipUrl: `https://codeload.github.com/imxade/${APP_SLUG}/zip/refs/heads/main`,
			},
		})
		expect(repository.vcs).toBe("folder")
		expect(repository.githubMirror?.htmlUrl).toBe(
			`https://github.com/imxade/${APP_SLUG}`,
		)
	})

	it("applies configured visibility and policy to new manifests", () => {
		const repository = createRepositoryManifest({
			owner: APP_SLUG,
			name: "private-default",
			rootFolderId: "drive-folder",
			files,
			visibility: "private",
			policy: {
				issuesEnabled: false,
				prsEnabled: false,
				allowUserCloseOwnIssues: false,
				requiredStatusForMerge: "reviewed",
			},
		})
		expect(repository.visibility).toBe("private")
		expect(repository.policy).toEqual({
			issuesEnabled: false,
			prsEnabled: false,
			allowUserCloseOwnIssues: false,
			requiredStatusForMerge: "reviewed",
		})
	})

	it("excludes VCS metadata from uploads instead of failing the folder", () => {
		const accepted = prepareRepositoryUploadFiles(
			[
				{
					path: "demo/.git/description",
					content: "private metadata",
				},
				{
					path: "demo/src/index.ts",
					content: "export {}",
				},
			],
			createDefaultSettings(),
			"repository",
		)

		expect(accepted.map((file) => file.path)).toEqual(["src/index.ts"])
	})

	it("reports client upload counts after root gitignore filtering", async () => {
		const file = (path: string, content: string) => {
			const upload = new File([content], path)
			Object.defineProperty(upload, "webkitRelativePath", { value: path })
			return upload
		}

		await expect(
			summarizeClientUploadFiles([
				file("demo/.gitignore", "node_modules\n"),
				file("demo/.git/description", "private metadata"),
				file("demo/node_modules/pkg/index.js", "ignored"),
				file("demo/src/index.ts", "export {}"),
			]),
		).resolves.toEqual({
			selected: 4,
			accepted: 2,
			acceptedBytes: 22,
		})
	})

	it("builds client upload archives from accepted files only", async () => {
		const file = (path: string, content: string) => {
			const upload = new File([content], path)
			Object.defineProperty(upload, "webkitRelativePath", { value: path })
			return upload
		}
		const archive = await prepareClientUploadArchive({
			files: [
				file("demo/.gitignore", "node_modules\n"),
				file("demo/.git/description", "private metadata"),
				file("demo/node_modules/pkg/index.js", "ignored"),
				file("demo/src/index.ts", "export {}"),
			],
			settings: createDefaultSettings(),
			kind: "repository",
		})
		const zipEntries = await unzipBlob(archive.blob)

		expect(zipEntries.map((entry) => entry.path)).toEqual([
			".gitignore",
			"src/index.ts",
		])
	})

	it("keeps temporary ZIP download cleanup detached and bounded", () => {
		expect(APP_DOWNLOAD.cleanupDelayMs).toBeGreaterThanOrEqual(0)
		expect(APP_DOWNLOAD.cleanupGraceMs).toBe(APP_TIMING.msPerHour)
		expect(APP_DOWNLOAD.stagedDownloadSweepMaxDeletes).toBe(10)
		expect(Object.keys(APP_DOWNLOAD)).toEqual([
			"cleanupDelayMs",
			"cleanupGraceMs",
			"stagedDownloadSweepMaxDeletes",
		])
	})

	it("builds public Drive API media URLs without Drive credentials", () => {
		const url = new URL(
			googleDrivePublicFileMediaUrl("file id/with slash", "browser api key"),
		)

		expect(url.origin + url.pathname).toBe(
			`${GOOGLE_DRIVE_API.filesUrl}/file%20id%2Fwith%20slash`,
		)
		expect(url.searchParams.get("alt")).toBe("media")
		expect(url.searchParams.get("acknowledgeAbuse")).toBe("true")
		expect(url.searchParams.get("key")).toBe("browser api key")
		expect(url.searchParams.has("access_token")).toBe(false)
		expect(url.searchParams.has("authorization")).toBe(false)
	})

	it("fetches temporary ZIP copies and schedules detached cleanup", async () => {
		vi.useFakeTimers()
		const revokeZipDownload = vi.fn(async () => undefined)
		const cleanupDelayMs = 25
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(new Blob(["zip-bytes"]), { status: 200 }),
		)

		const download = await downloadRepositoryZipFile(
			zipDownloadContext(revokeZipDownload, cleanupDelayMs),
			APP_SLUG,
		)

		expect(await download.blob.text()).toBe("zip-bytes")
		expect(download.name).toBe("demo.zip")
		expect(fetch).toHaveBeenCalledWith(
			"https://www.googleapis.com/drive/v3/files/temp?alt=media",
		)
		expect(revokeZipDownload).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(cleanupDelayMs)
		expect(revokeZipDownload).toHaveBeenCalledWith("signed-cleanup-ticket")
	})

	it("still schedules temporary ZIP cleanup when media fetch fails", async () => {
		vi.useFakeTimers()
		const revokeZipDownload = vi.fn(async () => undefined)
		const cleanupDelayMs = 25
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("forbidden", { status: 403 }),
		)

		await expect(
			downloadRepositoryZipFile(
				zipDownloadContext(revokeZipDownload, cleanupDelayMs),
				APP_SLUG,
			),
		).rejects.toThrow("Drive API ZIP download failed")
		expect(revokeZipDownload).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(cleanupDelayMs)
		expect(revokeZipDownload).toHaveBeenCalledWith("signed-cleanup-ticket")
	})

	it("fuzzy searches repositories by owner, name, description, and labels", () => {
		const repository = createRepositoryManifest({
			owner: "Ops Team",
			name: "drive-sync",
			description: "Portable backup mirror",
			rootFolderId: "drive-folder",
			files,
		})
		const summary = toRepositorySummary({
			...repository,
			labels: [
				...repository.labels,
				{
					id: "storage",
					name: "storage",
					color: "#0366d6",
					description: "Google Drive persistence",
				},
			],
		})
		expect(rankRepositoriesByQuery([summary], "ops sync")).toHaveLength(1)
		expect(rankRepositoriesByQuery([summary], "bkpmrr")).toHaveLength(1)
		expect(rankRepositoriesByQuery([summary], "persistence")).toHaveLength(1)
	})
})

describe("issues", () => {
	it("enforces issue ownership state transitions", () => {
		const repository = repo()
		const issue: IssueRecord = {
			id: "issue-1",
			number: 1,
			authorEmail: "user@example.com",
			title: "Bug",
			body: "Details",
			state: "open",
			labels: ["bug"],
			comments: [],
			createdAt: "2026-05-05T00:00:00.000Z",
			updatedAt: "2026-05-05T00:00:00.000Z",
		}
		const actor: Actor = { id: "u1", email: "user@example.com", role: "user" }
		expect(transitionIssueState(actor, repository, issue, "closed").state).toBe(
			"closed",
		)
		expect(() =>
			transitionIssueState(
				{ id: "u2", email: "other@example.com", role: "user" },
				repository,
				issue,
				"closed",
			),
		).toThrow("not permitted")
	})
})

describe("pull requests", () => {
	it("stores only changed uploaded files", () => {
		const uploaded = [
			{ path: "README.md", content: "hello", size: 5 },
			{ path: "src/index.ts", content: "console.log(2)", size: 14 },
			{ path: "src/new.ts", content: "export {}", size: 9 },
		]
		expect(
			diffRepositoryFiles(files, uploaded).map((diff) => diff.status),
		).toContain("modified")
		expect(
			compactPullRequestChanges(files, uploaded).map((file) => file.path),
		).toEqual(["src/index.ts", "src/new.ts"])
	})

	it("builds the same file set that an open PR would merge", () => {
		const merged = applyPullRequestFiles(files, {
			diff: [
				{ path: "README.md", status: "deleted" },
				{ path: "src/index.ts", status: "modified" },
				{ path: "src/new.ts", status: "added" },
			],
			files: [
				{ path: "src/index.ts", content: "console.log(2)", size: 14 },
				{ path: "src/new.ts", content: "export {}", size: 9 },
			],
		})
		expect(merged.map((file) => file.path)).toEqual([
			"src/index.ts",
			"src/new.ts",
		])
	})

	it("requires merge permission and review policy", () => {
		const repository = repo()
		repository.policy.requiredStatusForMerge = "reviewed"
		repository.maintainers.push({
			userId: "m1",
			email: "maintainer@example.com",
			permissions: ["merge"],
		})
		const pr: PullRequestRecord = {
			id: "pr-1",
			number: 1,
			authorEmail: "author@example.com",
			title: "Change",
			body: "",
			state: "open",
			createdAt: "2026-05-05T00:00:00.000Z",
			updatedAt: "2026-05-05T00:00:00.000Z",
		}
		expect(() =>
			assertCanMergePullRequest(
				{ id: "m1", email: "maintainer@example.com", role: "user" },
				repository,
				pr,
			),
		).toThrow("Review")
		pr.reviewedBy = "reviewer@example.com"
		expect(() =>
			assertCanMergePullRequest(
				{ id: "m1", email: "maintainer@example.com", role: "user" },
				repository,
				pr,
			),
		).not.toThrow()
	})

	it("lets private access grants participate and merge without settings access", () => {
		const repository = repo()
		repository.maintainers.push({
			userId: "owner",
			email: "owner@example.com",
			permissions: ["triage", "merge", "settings"],
		})
		repository.visibility = "private"
		repository.access = [
			{
				email: "granted@example.com",
				addedAt: "2026-05-05T00:00:00.000Z",
				addedBy: "admin@example.com",
			},
		]
		const actor: Actor = {
			id: "granted",
			email: "granted@example.com",
			role: "user",
		}
		expect(canMaintainRepository(actor, repository, "settings")).toBe(false)
		expect(canMaintainRepository(actor, repository, "triage")).toBe(true)
		expect(canMaintainRepository(actor, repository, "merge")).toBe(true)
		expect(
			canOwnRepository(
				{ id: "owner", email: "owner@example.com", role: "user" },
				repository,
			),
		).toBe(true)
		expect(
			canMaintainRepository(
				{ id: "admin", email: "admin@example.com", role: "admin" },
				repository,
				"settings",
			),
		).toBe(false)
	})

	it("preserves binary file hashes in diffs", () => {
		const base = [
			{
				path: "image.bin",
				content: "AAECAw==",
				encoding: "base64" as const,
				size: 4,
			},
		]
		const uploaded = [
			{
				path: "image.bin",
				content: "AAECAA==",
				encoding: "base64" as const,
				size: 4,
			},
		]
		expect(diffRepositoryFiles(base, uploaded)[0]?.status).toBe("modified")
	})
})

describe("activity", () => {
	it("resolves registered names in comment mentions including self mentions", () => {
		const users = {
			"ops@example.com": {
				email: "ops@example.com",
				ownerName: "Ops Team",
				createdAt: "2026-05-05T00:00:00.000Z",
				updatedAt: "2026-05-05T00:00:00.000Z",
			},
			"owner@example.com": {
				email: "owner@example.com",
				ownerName: "owner",
				createdAt: "2026-05-05T00:00:00.000Z",
				updatedAt: "2026-05-05T00:00:00.000Z",
			},
		}
		expect(
			resolveMentionedUsers("ping @owner", users).map((user) => user.email),
		).toContain("owner@example.com")
		expect(
			resolveMentionedUsers("self @owner", users).map((user) => user.email),
		).toEqual(["owner@example.com"])
		expect(
			resolveMentionedUsers("ping @Ops Team and @ops-team", users).map(
				(user) => user.email,
			),
		).toEqual(["ops@example.com"])
	})
})
