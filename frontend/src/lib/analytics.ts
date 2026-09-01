/**
 * Privacy-first analytics for the Stellar Royalty Splitter frontend (#524).
 *
 * Design choices:
 * - **No PII**: events carry only enumerated `AnalyticsEvent` names and a
 *   bounded `props` map of primitives. The tracker scrubs anything that
 *   looks like a Stellar address (G..., C..., S...) or hex hash before
 *   any event is buffered.
 * - **Opt-in only**: nothing is sent until `analytics.enable()` is called.
 *   The opt-in choice is persisted to `localStorage` under
 *   `srs_analytics_optin` so it survives page reloads.
 * - **Local queue + pluggable sink**: events go through a single
 *   `dispatch(event)` entry point so the UI is decoupled from the sink.
 *   A console sink is built-in and is the default for local dev; a
 *   `beacon` sink (using `navigator.sendBeacon`) can be wired to a
 *   remote endpoint by calling `analytics.configure({ endpoint })`.
 * - **Funnels via session id**: a session id (random, regenerated per
 *   tab load, never persisted) is attached to every event so events
 *   from the same visit can be grouped without identifying the user.
 */

const STORAGE_OPTIN = "srs_analytics_optin";

/** Enumerated event names tracked by the UI. */
export type AnalyticsEvent =
  | "page_view"
  | "wallet_connect_start"
  | "wallet_connect_success"
  | "wallet_connect_failed"
  | "contract_initialize_submit"
  | "contract_initialize_success"
  | "distribute_submit"
  | "distribute_success"
  | "distribute_error"
  | "secondary_sale_record"
  | "secondary_royalty_distribute"
  | "settings_changed"
  | "help_opened"
  | "shortcut_used"
  | "offline_detected"
  | "online_restored"
  | "session_expired";

/** Whitelist of event names — anything else is dropped at dispatch. */
const ALLOWED_EVENTS = new Set<AnalyticsEvent>([
  "page_view",
  "wallet_connect_start",
  "wallet_connect_success",
  "wallet_connect_failed",
  "contract_initialize_submit",
  "contract_initialize_success",
  "distribute_submit",
  "distribute_success",
  "distribute_error",
  "secondary_sale_record",
  "secondary_royalty_distribute",
  "settings_changed",
  "help_opened",
  "shortcut_used",
  "offline_detected",
  "online_restored",
  "session_expired",
]);

export type PropValue = string | number | boolean | null;
export interface EventProps {
  [key: string]: PropValue;
}

interface DispatchedEvent {
  name: AnalyticsEvent;
  props: EventProps;
  session_id: string;
  ts: number;
}

export type AnalyticsSink = (event: DispatchedEvent) => void;

interface Config {
  endpoint?: string;
  sink?: AnalyticsSink;
  /** Bounded buffer size; oldest events are dropped when exceeded. */
  bufferSize: number;
}

const STELLAR_ADDR_RE = /^[GCS][A-Z2-7]{55}$/;
const HEX_HASH_RE = /^[0-9a-fA-F]{32,}$/;

function looksLikePII(value: PropValue): boolean {
  if (typeof value !== "string") return false;
  return STELLAR_ADDR_RE.test(value) || HEX_HASH_RE.test(value);
}

/** Scrub PII-looking string values from props. Numbers/booleans pass through. */
export function scrubProps(props: EventProps): EventProps {
  const out: EventProps = {};
  for (const [k, v] of Object.entries(props)) {
    out[k] = looksLikePII(v) ? "[redacted]" : v;
  }
  return out;
}

function makeSessionId(): string {
  // Use crypto.randomUUID when available; fall back to a short random for jsdom.
  const c = typeof globalThis !== "undefined" ? (globalThis as { crypto?: Crypto }).crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `s_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

function defaultConsoleSink(event: DispatchedEvent): void {
  // eslint-disable-next-line no-console
  console.debug("[analytics]", event.name, event.props, {
    session_id: event.session_id,
  });
}

class Analytics {
  private enabled = false;
  private sessionId = makeSessionId();
  private buffer: DispatchedEvent[] = [];
  private config: Config = {
    bufferSize: 100,
    sink: defaultConsoleSink,
  };

  constructor() {
    // Restore opt-in choice from localStorage when running in a browser.
    if (typeof localStorage !== "undefined") {
      this.enabled = localStorage.getItem(STORAGE_OPTIN) === "true";
    }
  }

  configure(cfg: Partial<Config>): void {
    this.config = { ...this.config, ...cfg };
  }

  enable(): void {
    this.enabled = true;
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_OPTIN, "true");
    }
  }

  disable(): void {
    this.enabled = false;
    this.buffer = [];
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_OPTIN, "false");
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Reset the in-memory session id; used by tests. */
  _resetSession(): void {
    this.sessionId = makeSessionId();
    this.buffer = [];
  }

  /** Direct buffer read for tests/dashboards; returns a copy. */
  getBuffer(): DispatchedEvent[] {
    return this.buffer.slice();
  }

  dispatch(name: AnalyticsEvent, props: EventProps = {}): void {
    if (!this.enabled) return;
    if (!ALLOWED_EVENTS.has(name)) return;
    const event: DispatchedEvent = {
      name,
      props: scrubProps(props),
      session_id: this.sessionId,
      ts: Date.now(),
    };
    this.buffer.push(event);
    if (this.buffer.length > this.config.bufferSize) {
      this.buffer.shift();
    }
    try {
      this.config.sink?.(event);
    } catch {
      // Sink failures must never break the UI.
    }
    if (this.config.endpoint && typeof navigator !== "undefined") {
      const beacon = (navigator as Navigator & {
        sendBeacon?: (url: string, data?: BodyInit) => boolean;
      }).sendBeacon;
      if (typeof beacon === "function") {
        try {
          beacon.call(navigator, this.config.endpoint, JSON.stringify(event));
        } catch {
          // Beacon failures are silently dropped — analytics are best-effort.
        }
      }
    }
  }
}

/** Module-level singleton. */
export const analytics = new Analytics();
