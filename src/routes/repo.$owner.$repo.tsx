import { createFileRoute, useLocation } from "@tanstack/react-router"
import { RepositoryPage } from "../components/app-pages/RepositoryPage"

export const Route = createFileRoute("/repo/$owner/$repo")({
	component: RouteComponent,
})

function RouteComponent() {
	const { owner, repo } = Route.useParams()
	const location = useLocation()
	const suffix = location.pathname
		.replace(
			`/repo/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
			"",
		)
		.replace(/^\/+/, "")
	const [section, detail] = suffix.split("/")
	const detailNumber =
		detail && /^\d+$/.test(detail) ? Number(detail) : undefined

	if (section === "issues") {
		return (
			<RepositoryPage
				owner={owner}
				repo={repo}
				view="issues"
				itemNumber={detailNumber}
			/>
		)
	}
	if (section === "pulls") {
		return (
			<RepositoryPage
				owner={owner}
				repo={repo}
				view="pulls"
				itemNumber={detailNumber}
				newPullRequest={detail === "new"}
			/>
		)
	}
	if (section === "settings") {
		return <RepositoryPage owner={owner} repo={repo} view="settings" />
	}
	return <RepositoryPage owner={owner} repo={repo} />
}
