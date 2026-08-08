import { afterEach, describe, expect, it } from "vitest"
import { APP_ENV } from "../../src/lib/app-config"
import {
	appendRepositorySnapshot,
	type RepositorySnapshot,
} from "../../src/lib/drive-state"
import { hasValidIntegrationToken } from "../../src/lib/integration-server"

const previousToken = process.env[APP_ENV.integrationReadToken]

afterEach(() => {
	if (previousToken === undefined)
		delete process.env[APP_ENV.integrationReadToken]
	else process.env[APP_ENV.integrationReadToken] = previousToken
})

describe("deployment integration state", () => {
	it("appends durable, monotonic exact-revision events", () => {
		const snapshot: RepositorySnapshot = {
			revision: "a".repeat(64),
			sha256: "a".repeat(64),
			archiveBytes: 123,
			driveFileId: "drive-file-1",
			createdAt: "2026-08-09T00:00:00.000Z",
			source: "pull_request.merged",
			pullRequestNumber: 7,
		}
		const first = appendRepositorySnapshot(
			{
				repositorySnapshots: {},
				integrationEvents: [],
				integrationNextCursor: 1,
			},
			"owner/repository",
			snapshot,
		)
		const second = appendRepositorySnapshot(first, "owner/repository", {
			...snapshot,
			driveFileId: "drive-file-2",
		})

		expect(second.integrationEvents.map((event) => event.cursor)).toEqual([
			1, 2,
		])
		expect(
			new Set(second.integrationEvents.map((event) => event.id)).size,
		).toBe(2)
		expect(second.repositorySnapshots["owner/repository"]).toHaveLength(2)
		expect(second.integrationNextCursor).toBe(3)
	})

	it("requires an exact constant-time bearer credential for private access", () => {
		const token = "integration-test-token-that-is-long-enough"
		process.env[APP_ENV.integrationReadToken] = token
		expect(
			hasValidIntegrationToken(new Request("https://harbur.example")),
		).toBe(false)
		expect(() =>
			hasValidIntegrationToken(
				new Request("https://harbur.example", {
					headers: {
						Authorization: "Bearer incorrect-token-that-is-long-enough",
					},
				}),
			),
		).toThrow("invalid")
		expect(
			hasValidIntegrationToken(
				new Request("https://harbur.example", {
					headers: { Authorization: `Bearer ${token}` },
				}),
			),
		).toBe(true)
	})
})
