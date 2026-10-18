/**
 * CQRS Command: DistributeRoyalties (#1066)
 * Wraps the existing distribute flow and emits a domain event.
 */
import { appendEvent, EventTypes, AggregateTypes } from "../events/event-store.js";
import { buildAndRecordTransaction } from "../routes/_shared.js";
import { addressToScVal } from "../stellar.js";

export async function handleDistributeCommand({ contractId, walletAddress, tokenId, metadata = {} }) {
  const { xdr, transactionId } = await buildAndRecordTransaction({
    contractId,
    walletAddress,
    transactionType: "distribute",
    scvlArgs: [addressToScVal(tokenId)],
    auditAction: "distribution_initiated",
    auditMetadata: { tokenId },
    transactionMetadata: { tokenId },
  });

  await appendEvent({
    eventType: EventTypes.DISTRIBUTION_INITIATED,
    aggregateType: AggregateTypes.CONTRACT,
    aggregateId: contractId,
    contractId,
    actor: walletAddress,
    payload: { transactionId, tokenId, xdr },
    metadata,
  });

  return { xdr, transactionId };
}
