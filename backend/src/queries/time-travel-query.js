/**
 * CQRS Query: TimeTravelDebug (#1066)
 * Rebuilds projected contract state at any past point in time.
 */
import { replayEvents, AggregateTypes } from "../events/event-store.js";
import { contractStateReducer } from "../projections/contract-state-projection.js";

export async function queryStateAtTime(contractId, asOf) {
  return replayEvents(
    AggregateTypes.CONTRACT,
    contractId,
    contractStateReducer,
    { contractId, distributions: [], collaborators: [], initialized: false },
    { asOf }
  );
}
