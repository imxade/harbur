import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"
import {
	hasValidIntegrationToken,
	IntegrationHttpError,
	integrationErrorResponse,
	integrationEventPage,
	loadIntegrationState,
} from "../lib/integration-server"

const querySchema = z.object({
	after: z.coerce.number().int().nonnegative().default(0),
	limit: z.coerce.number().int().min(1).max(100).default(50),
})

export const Route = createFileRoute("/api/integrations/v1/events")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				try {
					if (!hasValidIntegrationToken(request)) {
						throw new IntegrationHttpError(401, "A Bearer token is required.")
					}
					const url = new URL(request.url)
					const query = querySchema.parse({
						after: url.searchParams.get("after") ?? undefined,
						limit: url.searchParams.get("limit") ?? undefined,
					})
					const { state } = await loadIntegrationState()
					return Response.json(
						integrationEventPage(state, query.after, query.limit),
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
