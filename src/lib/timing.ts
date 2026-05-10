import { APP_ENV, APP_TIMING } from "./app-config"

type TimingDetails = Record<string, unknown>
type TimingOutcome<T> = {
	result?: T
	error?: unknown
	durationMs: number
}
type TimingDetailsInput<T> =
	| TimingDetails
	| ((outcome: TimingOutcome<T>) => TimingDetails)

type TimingSpan = TimingDetails & {
	label: string
	durationMs: number
}
type TimingContext = {
	spans: TimingSpan[]
}
type TimingStorage = {
	getStore(): TimingContext | undefined
	run<T>(context: TimingContext, callback: () => T): T
}

let timingStoragePromise: Promise<TimingStorage | null> | null = null

async function timingStorage() {
	timingStoragePromise ??= loadTimingStorage()
	return await timingStoragePromise
}

async function loadTimingStorage(): Promise<TimingStorage | null> {
	if (typeof window !== "undefined") return null
	try {
		const { AsyncLocalStorage } = await import("node:async_hooks")
		return new AsyncLocalStorage<TimingContext>()
	} catch {
		return null
	}
}

function shouldLog(durationMs: number, thresholdMs: number) {
	const timingFlag =
		typeof process !== "undefined" ? process.env?.[APP_ENV.timing] : undefined
	return timingFlag === APP_TIMING.enabledValue || durationMs >= thresholdMs
}

function resolveDetails<T>(
	details: TimingDetailsInput<T>,
	outcome: TimingOutcome<T>,
) {
	try {
		const resolved = typeof details === "function" ? details(outcome) : details
		return Object.fromEntries(
			Object.entries(resolved).filter(([, value]) => value !== undefined),
		)
	} catch {
		return { timingDetailsError: true }
	}
}

function logSpan(span: TimingSpan, thresholdMs: number) {
	if (shouldLog(span.durationMs, thresholdMs)) {
		console.info(APP_TIMING.logPrefix, span)
	}
}

export async function timed<T>(
	label: string,
	run: () => Promise<T>,
	details: TimingDetailsInput<T> = {},
	thresholdMs = APP_TIMING.slowSpanMs,
) {
	const startedAt = performance.now()
	let result: T | undefined
	let error: unknown
	try {
		result = await run()
		return result
	} catch (cause) {
		error = cause
		throw cause
	} finally {
		const durationMs = Math.round(performance.now() - startedAt)
		const span = {
			label,
			durationMs,
			...resolveDetails(details, { result, error, durationMs }),
		}
		const context = (await timingStorage())?.getStore()
		if (context) {
			context.spans.push(span)
		} else {
			logSpan(span, thresholdMs)
		}
	}
}

export async function timedWithBreakdown<T>(
	label: string,
	run: () => Promise<T>,
	details: TimingDetailsInput<T> = {},
	thresholdMs = APP_TIMING.slowSpanMs,
) {
	const storage = await timingStorage()
	const parentContext = storage?.getStore()
	const childSpans: TimingSpan[] = []
	const startedAt = performance.now()
	let result: T | undefined
	let error: unknown
	try {
		result = storage
			? await storage.run({ spans: childSpans }, run)
			: await run()
		return result
	} catch (cause) {
		error = cause
		throw cause
	} finally {
		const durationMs = Math.round(performance.now() - startedAt)
		const span = {
			label,
			durationMs,
			...resolveDetails(details, { result, error, durationMs }),
			breakdown: childSpans,
		}
		parentContext?.spans.push(span)
		logSpan(span, thresholdMs)
	}
}
