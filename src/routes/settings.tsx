import { createFileRoute } from "@tanstack/react-router"
import { SettingsPage } from "../components/app-pages/SettingsPage"

export const Route = createFileRoute("/settings")({
	component: SettingsPage,
})
