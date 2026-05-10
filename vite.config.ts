import { defineConfig, type PluginOption } from "vite"
import { devtools } from "@tanstack/devtools-vite"
import { nitro } from "nitro/vite"

import { tanstackStart } from "@tanstack/react-start/plugin/vite"

import babel from "@rolldown/plugin-babel"
import viteReact, { reactCompilerPreset } from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const config = defineConfig(() => {
	const plugins: PluginOption[] = [
		devtools(),
		tanstackStart(),
		nitro(),
		viteReact(),
		babel({
			presets: [reactCompilerPreset()],
		}),
		tailwindcss(),
	]

	return {
		plugins,
		resolve: {
			alias: {
				daisyui: "daisyui/index.js",
			},
		},
	}
})

export default config
