/**
 * Projection: EarningsSummary (#1066)
 * Aggregates DistributionInitiated events into per-collaborator earnings totals.
 */
import { EventTypes } from "../events/event-store.js";
import { getContractEvents } from "../events/event-store.js";

export function earningsReducer(state, event) {
  if (event.eventType !== EventTypes.DISTRIBUTION_INITIATED) return state;
  const { tokenId } = event.payload;
  return {
    ...state,
    distributionCount: state.distributionCount + 1,
    lastDistributionAt: event.occurredAt,
    tokenIds: state.tokenIds.includes(tokenId)
      ? state.tokenIds
      : [...state.tokenIds, tokenId],
  };
}

/**
 * Project earnings summary for a contract, optionally up to a point in time.
 *
 * @param {string} contractId
 * @param {object} [opts]
 * @param {string} [opts.asOf]
 * @returns {{ distributionCount: number, lastDistributionAt: string|null, tokenIds: string[] }}
 */
export function projectEarningsSummary(contractId, opts = {}) {
  const events = getContractEvents(contractId, {
    eventType: EventTypes.DISTRIBUTION_INITIATED,
    toOccurredAt: opts.asOf,
  });

  return events.reduce(earningsReducer, {
    contractId,
    distributionCount: 0,
    lastDistributionAt: null,
    tokenIds: [],
  });
}
