/**
 * Configuration duplication utilities for royalty split configurations.
 * Enables users to clone existing configurations as editable drafts
 * without modifying on-chain data.
 */

export interface RoyaltyConfigDraft {
  sourceContractId?: string;
  sourceCreatedAt?: string;
  isDuplicate: boolean;
  duplicatedAt: string;
  collaborators: Array<{
    address: string;
    basisPoints: string;
  }>;
}

/**
 * Creates a draft configuration by duplicating an existing one
 * Does not modify any on-chain data
 */
export function duplicateConfiguration(
  sourceCollaborators: Array<{ address: string; basisPoints: number | string }>,
  sourceContractId?: string,
): RoyaltyConfigDraft {
  if (!sourceCollaborators || sourceCollaborators.length === 0) {
    throw new Error("Cannot duplicate: no collaborators to copy");
  }

  // Deep copy collaborators, converting basisPoints to string
  const duplicatedCollaborators = sourceCollaborators.map((collab) => ({
    address: collab.address,
    basisPoints: String(collab.basisPoints),
  }));

  return {
    sourceContractId,
    sourceCreatedAt: new Date().toISOString(),
    isDuplicate: true,
    duplicatedAt: new Date().toISOString(),
    collaborators: duplicatedCollaborators,
  };
}

/**
 * Validates that a configuration has valid duplicated data
 */
export function isValidDuplicateConfiguration(
  config: RoyaltyConfigDraft,
): boolean {
  if (!config.isDuplicate) return false;
  if (!config.duplicatedAt) return false;
  if (!Array.isArray(config.collaborators)) return false;
  if (config.collaborators.length === 0) return false;

  // Validate collaborator structure
  return config.collaborators.every(
    (c) => typeof c.address === "string" && typeof c.basisPoints === "string",
  );
}

/**
 * Gets a human-readable description of the source configuration
 */
export function getDuplicateSourceDescription(
  draft: RoyaltyConfigDraft,
): string {
  if (!draft.sourceContractId) {
    return "Configuration";
  }

  const shortId = draft.sourceContractId.slice(0, 7) + "...";
  return `Configuration from ${shortId}`;
}

/**
 * Converts a duplicate draft back to the standard form format
 */
export function draftToCollaborators(
  draft: RoyaltyConfigDraft,
): Array<{ address: string; basisPoints: string }> {
  return draft.collaborators.map((c) => ({
    address: c.address,
    basisPoints: c.basisPoints,
  }));
}

/**
 * Creates a duplicate info banner message
 */
export function getDuplicateBannerMessage(draft: RoyaltyConfigDraft): string {
  const source = getDuplicateSourceDescription(draft);
  const collaboratorCount = draft.collaborators.length;
  return `📋 Editing a duplicate: ${collaboratorCount} collaborator${collaboratorCount !== 1 ? "s" : ""} copied from ${source}. This is a draft — changes won't affect the original.`;
}
