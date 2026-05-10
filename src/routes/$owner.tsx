import { Link, createFileRoute } from "@tanstack/react-router"
import { useAppShell } from "../components/AppShellProvider"
import { DriveLoadingState } from "../components/app-pages/LoadingStates"
import RepositoryCard from "../components/RepositoryCard"
import { toRepositorySummary } from "../lib/search"

export const Route = createFileRoute("/$owner")({
	component: OwnerPage,
})

function OwnerPage() {
	const { owner } = Route.useParams()
	const { driveState, error, providerStatus } = useAppShell()
	const repositories =
		driveState?.repositories
			.filter((repo) => repo.owner === owner)
			.map(toRepositorySummary)
			.sort((left, right) =>
				left.repositoryName.localeCompare(right.repositoryName),
			) ?? []

	return (
		<main className="max-w-6xl mx-auto px-4 pb-12 pt-6 sm:pt-8">
			<div className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
				<div className="min-w-0">
					<p className="text-sm text-base-content/60">Owner</p>
					<h1 className="break-all text-3xl font-extrabold text-base-content sm:text-5xl">
						{owner}
					</h1>
				</div>
				<Link to="/" className="btn btn-outline btn-sm w-full sm:w-auto">
					All owners
				</Link>
			</div>

			{error ? <div className="alert alert-error mb-8">{error}</div> : null}

			{(providerStatus === "loading" || providerStatus === "ready") &&
			!driveState ? (
				<div className="mb-8">
					<DriveLoadingState title="Loading owner repositories" />
				</div>
			) : null}

			{driveState ? (
				repositories.length === 0 ? (
					<div className="rounded-lg border border-base-300 bg-base-100 p-8 text-center text-base-content/60">
						No repositories have been published by {owner}.
					</div>
				) : (
					<section className="mb-10">
						<h2 className="mb-4 text-xl font-bold text-base-content">
							{repositories.length} repositor
							{repositories.length === 1 ? "y" : "ies"}
						</h2>
						<div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
							{repositories.map((repository) => (
								<RepositoryCard key={repository.id} repository={repository} />
							))}
						</div>
					</section>
				)
			) : null}
		</main>
	)
}
