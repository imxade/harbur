import { createFileRoute } from "@tanstack/react-router"
import { RepositoryPage } from "../components/app-pages/RepositoryPage"

export const Route = createFileRoute("/repo/$owner/$repo/issues")({
	component: RouteComponent,
})

function RouteComponent() {
	const { owner, repo } = Route.useParams()
	return <RepositoryPage owner={owner} repo={repo} view="issues" />
}
