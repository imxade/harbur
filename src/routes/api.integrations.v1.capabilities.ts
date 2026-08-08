import { createFileRoute } from "@tanstack/react-router"
import { integrationConfigured } from "../lib/integration-server"

export const Route = createFileRoute("/api/integrations/v1/capabilities")({
	server: {
		handlers: {
			GET: () =>
				Response.json({
					apiVersion: "v1",
					authentication: {
						type: "bearer",
						configured: integrationConfigured(),
					},
					snapshots: {
						immutable: true,
						revision: "sha256",
						archive: "zip",
					},
					events: { delivery: "poll", cursor: "integer" },
				}),
		},
	},
})
