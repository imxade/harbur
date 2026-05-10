import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router"
import AppShellProvider from "../components/AppShellProvider"
import Header from "../components/Header"
import { APP_NAME } from "../lib/app-config"
import "../styles.css"

const THEME_INIT_SCRIPT = `
try {
	var t = localStorage.getItem('${APP_NAME}-theme');
	if (t !== 'cupcake' && t !== 'dracula') t = 'dracula';
	document.documentElement.setAttribute('data-theme', t);
} catch (e) {}
`

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: `${APP_NAME} | Drive-backed code collaboration` },
			{
				name: "description",
				content: `Drive-backed code collaboration with Google SSO and ${APP_NAME} app sessions.`,
			},
		],
	}),
	shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" data-theme="dracula" suppressHydrationWarning>
			<head>
				{/* biome-ignore lint/security/noDangerouslySetInnerHtml: Theme initialization script */}
				<script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
				<HeadContent />
			</head>
			<body
				className="min-h-screen overflow-x-hidden bg-base-200 font-sans antialiased"
				suppressHydrationWarning
			>
				<AppShellProvider>
					<div className="flex flex-col min-h-screen">
						<Header />
						<div className="flex-1">{children}</div>
					</div>
				</AppShellProvider>
				<Scripts />
			</body>
		</html>
	)
}
