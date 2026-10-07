import { clipboard } from "electron";
import { STELLAR_ACCOUNT_REGEX, STELLAR_CONTRACT_REGEX } from "./constants.js";

/**
 * Validates whether a text matches a Stellar address or contract ID.
 * @param {string} text
 * @returns {{ isMatch: boolean, type?: 'account' | 'contract', value?: string }}
 */
export function matchStellarAddress(text) {
  if (!text || typeof text !== "string") {
    return { isMatch: false };
  }

  const trimmed = text.trim();
  if (STELLAR_ACCOUNT_REGEX.test(trimmed)) {
    return { isMatch: true, type: "account", value: trimmed };
  }
  if (STELLAR_CONTRACT_REGEX.test(trimmed)) {
    return { isMatch: true, type: "contract", value: trimmed };
  }

  return { isMatch: false };
}

export class ClipboardWatcher {
  /**
   * @param {object} options
   * @param {number} [options.intervalMs=1000]
   * @param {(match: { type: 'account' | 'contract', value: string }) => void} [options.onAddressDetected]
   * @param {typeof clipboard} [options.clipboardProvider=clipboard]
   */
  constructor(options = {}) {
    this.intervalMs = options.intervalMs || 1000;
    this.onAddressDetected = options.onAddressDetected || (() => {});
    this.clipboard = options.clipboardProvider || clipboard;
    this.lastCheckedText = "";
    this.timer = null;
    this.enabled = false;
  }

  start() {
    if (this.enabled) return;
    this.enabled = true;

    // Initialise lastCheckedText to avoid triggering on whatever was already copied
    try {
      this.lastCheckedText = this.clipboard.readText().trim();
    } catch (_err) {
      this.lastCheckedText = "";
    }

    this.timer = setInterval(() => this.check(), this.intervalMs);
  }

  stop() {
    if (!this.enabled) return;
    this.enabled = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  check() {
    if (!this.enabled) return;
    try {
      const currentText = this.clipboard.readText().trim();
      if (!currentText || currentText === this.lastCheckedText) {
        return;
      }

      this.lastCheckedText = currentText;
      const match = matchStellarAddress(currentText);
      if (match.isMatch) {
        this.onAddressDetected({
          type: match.type,
          value: match.value,
        });
      }
    } catch (_err) {
      // Ignore clipboard read errors
    }
  }

  isEnabled() {
    return this.enabled;
  }
}
