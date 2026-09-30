/**
 * CQRS Command: OpenDispute / ResolveDispute (#1066)
 */
import { appendEvent, EventTypes, AggregateTypes } from "../events/event-store.js";

export async function handleOpenDisputeCommand({ disputeId, contractId, actor, reason, metadata = {} }) {
  const result = await appendEvent({
    eventType: EventTypes.DISPUTE_OPENED,
    aggregateType: AggregateTypes.DISPUTE,
    aggregateId: String(disputeId),
    contractId,
    actor,
    payload: { disputeId, reason },
    metadata,
  });
  return result;
}

export async function handleResolveDisputeCommand({ disputeId, contractId, actor, resolution, metadata = {} }) {
  const result = await appendEvent({
    eventType: EventTypes.DISPUTE_RESOLVED,
    aggregateType: AggregateTypes.DISPUTE,
    aggregateId: String(disputeId),
    contractId,
    actor,
    payload: { disputeId, resolution },
    metadata,
  });
  return result;
}
