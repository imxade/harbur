import { createFileRoute } from "@tanstack/react-router"
import {
	hasValidIntegrationToken,
	integrationErrorResponse,
	integrationRepositoryList,
	loadIntegrationState,
} from "../lib/integration-server"

export const Route = createFileRoute("/api/integrations/v1/repositories")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				try {
					const includePrivate = hasValidIntegrationToken(request)
					const { state } = await loadIntegrationState()
					return Response.json(
						{
							repositories: integrationRepositoryList(state, includePrivate),
						},
						{
							headers: {
								"Cache-Control": "private, no-store",
								Vary: "Authorization",
							},
						},
					)
				} catch (error) {
					return integrationErrorResponse(error)
				}
			},
		},
	},
})
