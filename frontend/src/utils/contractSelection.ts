/**
 * Pure helpers for the "select all" checkbox on the contract performance table.
 */

/**
 * True when every contract in `contractIds` is in `selected`.
 *
 * Membership is checked per ID rather than comparing set sizes, so stale IDs
 * left in `selected` (for example a contract that dropped out of the data) do
 * not affect the result. An empty list is never "all selected".
 */
export function areAllContractsSelected(
  selected: ReadonlySet<string>,
  contractIds: readonly string[]
): boolean {
  return contractIds.length > 0 && contractIds.every((id) => selected.has(id));
}

/**
 * Next selection after the select-all control is toggled. Clears the selection
 * when every contract is already selected, otherwise selects all of them.
 *
 * Always returns a new Set and never mutates `selected`, so React sees a state
 * change on every toggle.
 */
export function toggleSelectAllContracts(
  selected: ReadonlySet<string>,
  contractIds: readonly string[]
): Set<string> {
  if (areAllContractsSelected(selected, contractIds)) {
    return new Set();
  }
  return new Set(contractIds);
}
