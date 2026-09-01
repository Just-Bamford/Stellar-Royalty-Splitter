/**
 * JSON import/export format for royalty split configurations (#666, #665).
 *
 * Mirrors the collaborator address/percentage rules enforced by
 * InitializeForm.tsx so an imported file can only ever produce a
 * collaborator list that the contract's `initialize()` would accept.
 */

// Same shape InitializeForm.tsx uses internally: basisPoints holds the
// *percentage* (0-100) entered by the user, not raw contract basis points.
export interface RoyaltyConfigCollaborator {
  address: string;
  basisPoints: string;
}

export interface RoyaltyConfigFile {
  version: number;
  createdAt: string;
  collaborators: Array<{ address: string; percentage: number }>;
}

export const ROYALTY_CONFIG_VERSION = 1;

/** All schema versions this client can read. Extend when adding new versions. */
export const SUPPORTED_CONFIG_VERSIONS = [1] as const;
export type SupportedConfigVersion = (typeof SUPPORTED_CONFIG_VERSIONS)[number];

// Mirrors InitializeForm.tsx's STELLAR_ADDRESS_RE / MAX_COLLABORATORS.
const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
const MAX_COLLABORATORS = 50;

export class RoyaltyConfigImportError extends Error {
  errors: string[];

  constructor(errors: string[]) {
    super(errors[0] ?? "Invalid royalty configuration file.");
    this.name = "RoyaltyConfigImportError";
    this.errors = errors;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses and validates the raw text of an imported royalty configuration
 * JSON file. Treats the input as untrusted: every field is checked before
 * any value is used. Throws `RoyaltyConfigImportError` (with all collected
 * error messages) rather than returning partially-valid data.
 */
export function parseRoyaltyConfigImport(raw: string): RoyaltyConfigCollaborator[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RoyaltyConfigImportError(["File is not valid JSON."]);
  }

  if (!isPlainObject(parsed)) {
    throw new RoyaltyConfigImportError([
      "File must contain a JSON object with a \"collaborators\" array.",
    ]);
  }

  const { version, collaborators } = parsed as Record<string, unknown>;

  if (version === undefined || version === null) {
    throw new RoyaltyConfigImportError([
      `"version" field is required. Supported versions: ${SUPPORTED_CONFIG_VERSIONS.join(", ")}.`,
    ]);
  }

  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new RoyaltyConfigImportError(['"version" must be an integer.']);
  }

  if (!(SUPPORTED_CONFIG_VERSIONS as readonly number[]).includes(version)) {
    throw new RoyaltyConfigImportError([
      `Unsupported configuration version ${version}. Supported versions: ${SUPPORTED_CONFIG_VERSIONS.join(", ")}.`,
    ]);
  }

  if (!Array.isArray(collaborators) || collaborators.length === 0) {
    throw new RoyaltyConfigImportError([
      '"collaborators" must be a non-empty array.',
    ]);
  }

  if (collaborators.length > MAX_COLLABORATORS) {
    throw new RoyaltyConfigImportError([
      `Too many collaborators (${collaborators.length}). Maximum is ${MAX_COLLABORATORS}.`,
    ]);
  }

  const errors: string[] = [];
  const seenAddresses = new Set<string>();
  const result: RoyaltyConfigCollaborator[] = [];
  let total = 0;

  collaborators.forEach((entry, i) => {
    const row = i + 1;
    if (!isPlainObject(entry)) {
      errors.push(`Row ${row}: must be an object with "address" and "percentage".`);
      return;
    }

    const { address, percentage } = entry as Record<string, unknown>;

    if (typeof address !== "string" || !STELLAR_ADDRESS_RE.test(address)) {
      errors.push(`Row ${row}: "address" must be a valid Stellar address (G..., 56 chars).`);
      return;
    }

    if (seenAddresses.has(address)) {
      errors.push(`Row ${row}: duplicate collaborator address "${address}".`);
      return;
    }

    if (
      typeof percentage !== "number" ||
      !Number.isFinite(percentage) ||
      percentage <= 0 ||
      percentage > 100
    ) {
      errors.push(`Row ${row}: "percentage" must be a number greater than 0 and up to 100.`);
      return;
    }

    seenAddresses.add(address);
    total += percentage;
    result.push({ address, basisPoints: String(percentage) });
  });

  if (errors.length > 0) {
    throw new RoyaltyConfigImportError(errors);
  }

  // Contract requires stored shares to sum to exactly 10,000 basis points (100%).
  if (Math.round(total * 100) !== 10_000) {
    throw new RoyaltyConfigImportError([
      `Collaborator percentages must sum to 100% (file totals ${total.toFixed(2)}%).`,
    ]);
  }

  return result;
}

export class RoyaltyConfigExportError extends Error {
  errors: string[];

  constructor(errors: string[]) {
    super(errors[0] ?? "Royalty configuration is not valid for export.");
    this.name = "RoyaltyConfigExportError";
    this.errors = errors;
  }
}

/**
 * Builds a portable, public-only royalty configuration file from the current
 * setup form state. Only addresses and allocation percentages are included —
 * no wallet secrets or private application data ever pass through this form.
 *
 * Validates the collaborator list before generating the file (structure,
 * address format, duplicates, and that percentages sum to 100%) so an
 * export can never encode a configuration the contract would reject.
 */
export function buildRoyaltyConfigExport(
  collaborators: RoyaltyConfigCollaborator[],
  createdAt: string,
): RoyaltyConfigFile {
  const errors: string[] = [];
  const seenAddresses = new Set<string>();
  const entries: Array<{ address: string; percentage: number }> = [];
  let total = 0;

  if (collaborators.length === 0) {
    throw new RoyaltyConfigExportError(["Add at least one collaborator before exporting."]);
  }

  collaborators.forEach((c, i) => {
    const row = i + 1;
    if (!STELLAR_ADDRESS_RE.test(c.address)) {
      errors.push(`Row ${row}: "${c.address}" is not a valid Stellar address.`);
      return;
    }
    if (seenAddresses.has(c.address)) {
      errors.push(`Row ${row}: duplicate collaborator address "${c.address}".`);
      return;
    }

    const percentage = Number(c.basisPoints);
    if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
      errors.push(`Row ${row}: allocation must be a number greater than 0 and up to 100.`);
      return;
    }

    seenAddresses.add(c.address);
    total += percentage;
    entries.push({ address: c.address, percentage });
  });

  if (errors.length > 0) {
    throw new RoyaltyConfigExportError(errors);
  }

  if (Math.round(total * 100) !== 10_000) {
    throw new RoyaltyConfigExportError([
      `Collaborator percentages must sum to 100% before exporting (currently ${total.toFixed(2)}%).`,
    ]);
  }

  return {
    version: ROYALTY_CONFIG_VERSION,
    createdAt,
    collaborators: entries,
  };
}

/** Triggers a browser download of the given royalty configuration as JSON. */
export function downloadRoyaltyConfig(config: RoyaltyConfigFile, filename: string): void {
  const json = JSON.stringify(config, null, 2);
  const blob = new Blob([json], { type: "application/json;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
