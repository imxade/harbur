import { Archive, Bell, GitPullRequest, Search, Star } from "lucide-react"

const icons = {
	archive: Archive,
	bell: Bell,
	gitPullRequest: GitPullRequest,
	search: Search,
	star: Star,
}

export default function Icon({
	name,
	size = 20,
	className,
	strokeWidth,
}: {
	name: keyof typeof icons | string
	size?: number
	className?: string
	strokeWidth?: number
}) {
	const Component = icons[name as keyof typeof icons] ?? Archive
	return (
		<Component size={size} className={className} strokeWidth={strokeWidth} />
	)
}
