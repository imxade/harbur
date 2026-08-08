import { createFileRoute } from "@tanstack/react-router"
import {
	exactSnapshotArchive,
	integrationErrorResponse,
} from "../lib/integration-server"

export const Route = createFileRoute(
	"/api/integrations/v1/repositories/$owner/$repo/snapshots/$revision",
)({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				try {
					const { bytes, repository, snapshot } = await exactSnapshotArchive({
						request,
						owner: params.owner,
						repositoryName: params.repo,
						revision: params.revision,
					})
					return new Response(bytes, {
						headers: {
							"Cache-Control":
								repository.visibility === "public"
									? "public, max-age=31536000, immutable"
									: "private, no-store",
							"Content-Disposition": `attachment; filename="${repository.name}-${snapshot.revision}.zip"`,
							"Content-Length": String(snapshot.archiveBytes),
							"Content-Type": "application/zip",
							ETag: `"${snapshot.sha256}"`,
							Vary: "Authorization",
							"X-Content-SHA256": snapshot.sha256,
						},
					})
				} catch (error) {
					return integrationErrorResponse(error)
				}
			},
		},
	},
})
