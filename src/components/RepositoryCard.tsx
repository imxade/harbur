import { Link } from "@tanstack/react-router"
import type { RepositorySummary } from "../lib/search"
import { LinkifiedText } from "./LinkifiedText"

export default function RepositoryCard({
	repository,
}: {
	repository: RepositorySummary
}) {
	return (
		<article className="card relative h-full bg-base-100 shadow-sm border border-base-300 transition-colors hover:border-primary hover:bg-base-200">
			<div className="card-body gap-3 p-4 sm:p-6">
				<div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
					<h3 className="card-title break-all text-lg">
						<Link
							to={repository.href}
							className="after:absolute after:inset-0 focus:outline-none focus:ring-2 focus:ring-primary"
							aria-label={`Open ${repository.name}`}
						>
							{repository.name}
						</Link>
					</h3>
					<span
						className={
							repository.visibility === "private"
								? "badge badge-warning badge-sm shrink-0"
								: "badge badge-outline badge-sm shrink-0"
						}
					>
						{repository.visibility}
					</span>
				</div>
				<p className="break-words text-sm text-base-content/70">
					<LinkifiedText
						text={repository.description}
						linkClassName="link link-primary relative z-10"
					/>
				</p>
			</div>
		</article>
	)
}
