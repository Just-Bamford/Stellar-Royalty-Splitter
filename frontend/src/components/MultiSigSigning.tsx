import React, { useState } from "react";

export type MultisigProposalStatus = "pending" | "executed" | "cancelled";

export interface MultisigProposal {
  id: number;
  operation: string;
  threshold: number;
  requiredSigners: string[];
  approvers: string[];
  status: MultisigProposalStatus;
}

export interface MultiSigSigningProps {
  proposals: MultisigProposal[];
  currentUser: string;
  onSign: (proposalId: number, signature: string) => void;
  onExecute: (proposalId: number) => void;
  isProcessing?: boolean;
}

/** Returns true when the collected approvers meet the proposal threshold. */
export function isProposalFullySigned(
  proposal: Pick<MultisigProposal, "threshold" | "approvers">,
): boolean {
  return proposal.approvers.length >= proposal.threshold;
}

/** Number of additional distinct signatures required to reach the threshold. */
export function signersRemaining(
  proposal: Pick<MultisigProposal, "threshold" | "approvers">,
): number {
  return Math.max(0, proposal.threshold - proposal.approvers.length);
}

interface SignatureInputProps {
  proposalId: number;
  disabled: boolean;
  onSign: (proposalId: number, signature: string) => void;
}

function SignatureInput({ proposalId, disabled, onSign }: SignatureInputProps) {
  const [signature, setSignature] = useState("");

  return (
    <div className="multisig-signature-input" data-testid="multisig-signature-input">
      <input
        type="text"
        value={signature}
        onChange={(e) => setSignature(e.target.value)}
        placeholder="Paste your signature"
        disabled={disabled}
        data-testid="multisig-signature-field"
      />
      <button
        type="button"
        onClick={() => {
          if (signature.trim()) {
            onSign(proposalId, signature.trim());
            setSignature("");
          }
        }}
        disabled={disabled || !signature.trim()}
        data-testid="multisig-sign-btn"
      >
        Sign
      </button>
    </div>
  );
}

export const MultiSigSigning: React.FC<MultiSigSigningProps> = ({
  proposals,
  currentUser,
  onSign,
  onExecute,
  isProcessing = false,
}) => {
  if (!proposals || proposals.length === 0) {
    return (
      <div className="multisig-signing" data-testid="multisig-signing">
        <p data-testid="multisig-empty">No pending multi-signature proposals.</p>
      </div>
    );
  }

  return (
    <div className="multisig-signing" data-testid="multisig-signing">
      {proposals.map((proposal) => {
        const fullySigned = isProposalFullySigned(proposal);
        const currentUserSigned = proposal.approvers.includes(currentUser);
        const canSubmitSignature = proposal.status === "pending" && !currentUserSigned && !fullySigned;

        return (
          <div
            key={proposal.id}
            className="multisig-proposal"
            data-testid="multisig-proposal"
            data-proposal-id={proposal.id}
          >
            <div className="multisig-proposal-header" data-testid="multisig-proposal-header">
              <span data-testid="multisig-operation">{proposal.operation}</span>
              <span data-testid="multisig-progress">
                {proposal.approvers.length}/{proposal.threshold} signatures
              </span>
              {fullySigned ? null : (
                <span data-testid="multisig-remaining">{signersRemaining(proposal)} more needed</span>
              )}
              <span data-testid="multisig-status">{proposal.status}</span>
            </div>

            <div className="multisig-signers" data-testid="multisig-signers">
              {proposal.requiredSigners.map((signer) => (
                <span
                  key={signer}
                  className={proposal.approvers.includes(signer) ? "signer-signed" : "signer-pending"}
                  data-testid="multisig-signer"
                  data-signer={signer}
                >
                  {signer}
                </span>
              ))}
            </div>

            {currentUserSigned ? (
              <div data-testid="multisig-already-signed">You have already signed.</div>
            ) : canSubmitSignature ? (
              <SignatureInput
                proposalId={proposal.id}
                disabled={isProcessing}
                onSign={onSign}
              />
            ) : null}

            <button
              type="button"
              className="btn-primary"
              onClick={() => onExecute(proposal.id)}
              disabled={
                !fullySigned || !currentUserSigned || proposal.status !== "pending" || isProcessing
              }
              data-testid="multisig-execute-btn"
            >
              Execute
            </button>
          </div>
        );
      })}
    </div>
  );
};
