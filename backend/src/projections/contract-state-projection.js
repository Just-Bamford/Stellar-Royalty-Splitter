/**
 * Projection: ContractState (#1066)
 * Reduces a stream of domain events into a current-state view.
 * Pure function — no side effects, safe to replay multiple times.
 */
import { EventTypes } from "../events/event-store.js";

/**
 * Pure reducer: (state, event) => newState
 * Called by replayEvents for time-travel queries.
 */
export function contractStateReducer(state, event) {
  switch (event.eventType) {
    case EventTypes.CONTRACT_INITIALIZED:
      return {
        ...state,
        initialized: true,
        collaborators: event.payload.collaborators ?? [],
        shares: event.payload.shares ?? [],
        initializedAt: event.occurredAt,
        initializedBy: event.actor,
      };

    case EventTypes.DISTRIBUTION_INITIATED:
      return {
        ...state,
        distributions: [
          ...state.distributions,
          {
            transactionId: event.payload.transactionId,
            tokenId: event.payload.tokenId,
            initiatedAt: event.occurredAt,
            initiatedBy: event.actor,
          },
        ],
        lastDistributionAt: event.occurredAt,
      };

    case EventTypes.DISTRIBUTION_CONFIRMED:
      return {
        ...state,
        distributions: state.distributions.map((d) =>
          d.transactionId === event.payload.transactionId
            ? { ...d, confirmedAt: event.occurredAt, txHash: event.payload.txHash }
            : d
        ),
      };

    case EventTypes.DISTRIBUTION_FAILED:
      return {
        ...state,
        distributions: state.distributions.map((d) =>
          d.transactionId === event.payload.transactionId
            ? { ...d, failedAt: event.occurredAt, errorMessage: event.payload.errorMessage }
            : d
        ),
      };

    case EventTypes.COLLABORATOR_STATUS_CHANGED:
      return {
        ...state,
        collaborators: state.collaborators.map((c) =>
          c === event.payload.address
            ? event.payload.address // keep in list; status tracked elsewhere
            : c
        ),
      };

    default:
      return state;
  }
}

/**
 * Build the current projected state for a contract by replaying all its events.
 * Returns the final state object.
 *
 * @param {string} contractId
 * @param {object} [opts]
 * @param {string} [opts.asOf] - ISO datetime for time-travel
 */
import { replayEvents, AggregateTypes } from "../events/event-store.js";

export async function projectContractState(contractId, opts = {}) {
  return replayEvents(
    AggregateTypes.CONTRACT,
    contractId,
    contractStateReducer,
    { contractId, distributions: [], collaborators: [], initialized: false },
    opts
  );
}
