/**
 * CQRS Command: InitializeContract (#1066)
 */
import { appendEvent, EventTypes, AggregateTypes } from "../events/event-store.js";
import { buildAndRecordTransaction } from "../routes/_shared.js";
import { addressToScVal, vecToScVal, u32ToScVal } from "../stellar.js";

export async function handleInitializeCommand({ contractId, walletAddress, collaborators, shares, metadata = {} }) {
  const scvlArgs = [
    vecToScVal(collaborators.map(addressToScVal)),
    vecToScVal(shares.map(u32ToScVal)),
  ];

  const { xdr, transactionId } = await buildAndRecordTransaction({
    contractId,
    walletAddress,
    transactionType: "initialize",
    scvlArgs,
    auditAction: "contract_initialized",
    auditMetadata: { collaborators, shares },
    transactionMetadata: {},
  });

  await appendEvent({
    eventType: EventTypes.CONTRACT_INITIALIZED,
    aggregateType: AggregateTypes.CONTRACT,
    aggregateId: contractId,
    contractId,
    actor: walletAddress,
    payload: { transactionId, collaborators, shares },
    metadata,
  });

  return { xdr, transactionId };
}
