/**
 * CQRS Query: ContractHistory (#1066)
 * Returns all domain events for a contract, paginated.
 */
import { getContractEvents, countContractEvents } from "../events/event-store.js";

export function queryContractHistory(contractId, { eventType, fromOccurredAt, toOccurredAt, limit = 50, offset = 0 } = {}) {
  const events = getContractEvents(contractId, { eventType, fromOccurredAt, toOccurredAt, limit, offset });
  const total  = countContractEvents(contractId, { eventType, fromOccurredAt, toOccurredAt });
  return { events, total, limit, offset };
}
