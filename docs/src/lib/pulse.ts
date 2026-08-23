import { createPulse, type Pulse } from "@f0rbit/pulse-client";

// Static GitHub Pages site — no runtime env, so the ingest credentials are
// hardcoded. pk_* keys are write-only and safe to embed client-side.
const ENDPOINT = "https://pulse.devpad.tools";
const PROJECT_ID = "project_48a94a81-b0ef-4bc9-b7f9-c1d08dae78f5";
const INGEST_KEY = "pk_project4_d0b2f338464827cc064fae49";

let pulse_instance: Pulse | null = null;

const install_browser_handlers = (p: Pulse): void => {
	window.addEventListener("error", (e: ErrorEvent) => {
		p.captureError(e.error ?? new Error(e.message), {
			source: "window.onerror",
			filename: e.filename,
			lineno: e.lineno,
			colno: e.colno,
		});
	});
	window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
		p.captureError(e.reason ?? new Error("unhandledrejection"), {
			source: "unhandledrejection",
		});
	});
};

const ensure_initialized = (): Pulse | null => {
	if (typeof window === "undefined") return null;
	if (!pulse_instance) {
		pulse_instance = createPulse({
			project_id: PROJECT_ID,
			ingest_key: INGEST_KEY,
			endpoint: ENDPOINT,
			auto_pageview: true,
		});
		install_browser_handlers(pulse_instance);
	}
	return pulse_instance;
};

/** Lazy singleton pulse instance for manual flush / custom events. */
export const get_pulse = (): Pulse | null => ensure_initialized();

ensure_initialized();
