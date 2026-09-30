import React, { useCallback, useEffect, useMemo, useState } from 'react';

export interface QuoteResult {
  provider: string;
  inputAmount: string;
  minOutput: string;
  slippage: number;
  plan: Array<{
    provider: string;
    amount: string;
    minOutput: string;
    quote: Record<string, unknown>;
  }>;
  allQuotes: Array<Record<string, unknown>>;
}

export interface CrossChainBridgeProps {
  apiBaseUrl?: string;
  onSubmit?: (quote: QuoteResult) => void | Promise<void>;
  chains?: Array<{ id: string; label: string }>;
}

const DEFAULT_CHAINS = [
  { id: 'stellar', label: 'Stellar' },
  { id: 'ethereum', label: 'Ethereum' },
  { id: 'arbitrum', label: 'Arbitrum' },
  { id: 'optimism', label: 'Optimism' },
  { id: 'polygon', label: 'Polygon' },
  { id: 'avalanche', label: 'Avalanche' },
  { id: 'base', label: 'Base' },
];

function formatAmount(value: string | number | undefined): string {
  if (value === undefined || value === null) return '-';
  try {
    const big = BigInt(String(value));
    return big.toString();
  } catch {
    return String(value);
  }
}

export const CrossChainBridge: React.FC<CrossChainBridgeProps> = ({
  apiBaseUrl = '',
  onSubmit,
  chains = DEFAULT_CHAINS,
}) => {
  const [srcChain, setSrcChain] = useState(
    chains[0]?.id ?? 'stellar'
  );
  const [dstChain, setDstChain] = useState(chains[1]?.id ?? 'ethereum');
  const [amount, setAmount] = useState('');
  const [slippage, setSlippage] = useState(0.5);
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  const fetchQuote = useCallback(async () => {
    if (!amount || BigInt(amount) <= 0n) {
      setQuote(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const thorchainParams =
        srcChain === 'stellar' || dstChain === 'stellar'
          ? {
              fromAsset: srcChain === 'stellar' ? 'native' : 'ETH.ETH',
              toAsset: dstChain === 'stellar' ? 'native' : 'ETH.ETH',
              amount,
              destinationAddress: '0',
              refundAddress: '0',
            }
          : undefined;
      const stargateParams =
        srcChain !== 'stellar' && dstChain !== 'stellar'
          ? {
              srcChainId: srcChain,
              dstChainId: dstChain,
              srcTokenAddress: '0',
              dstTokenAddress: '0',
              amount,
              srcAddress: '0',
              dstAddress: '0',
              slippageTolerance: slippage / 100,
            }
          : undefined;

      const response = await fetch(`${apiBaseUrl}/api/cross-chain/quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount,
          thorchainParams,
          stargateParams,
          allowSplit: true,
          slippage: slippage / 100,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Quote request failed (${response.status})`);
      }
      const data = (await response.json()) as QuoteResult;
      setQuote(data);
    } catch (err) {
      setError((err as Error).message);
      setQuote(null);
    } finally {
      setLoading(false);
    }
  }, [amount, srcChain, dstChain, slippage, apiBaseUrl]);

  useEffect(() => {
    const handle = setTimeout(() => {
      void fetchQuote();
    }, 400);
    return () => clearTimeout(handle);
  }, [fetchQuote]);

  const handleSubmit = useCallback(
    async () => {
      if (!quote) {
        setError('Fetch a quote before confirming');
        return;
      }
      setSubmitting(true);
      setError(null);
      setSuccess(null);
      try {
        if (onSubmit) {
          await onSubmit(quote);
        } else {
          const response = await fetch(`${apiBaseUrl}/api/cross-chain/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              amount: quote.inputAmount,
              thorchainParams: undefined,
              stargateParams: undefined,
              allowSplit: true,
              slippage: quote.slippage,
            }),
          });
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error || `Bridge failed (${response.status})`);
          }
        }
        setSuccess('Bridge transfer submitted');
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSubmitting(false);
      }
    },
    [quote, onSubmit, apiBaseUrl]
  );

  const effectiveRate = useMemo(() => {
    if (!quote || !quote.inputAmount || !quote.minOutput) return null;
    try {
      const in = BigInt(quote.inputAmount);
      const out = BigInt(quote.minOutput);
      if (in === 0n) return null;
      return Number(out) / Number(in);
    } catch {
      return null;
    }
  }, [quote]);

  return (
    <div className="cross-chain-bridge">
      <h1>Cross-chain Bridge</h1>
      <div className="row">
        <label>
          From chain
          <select value={srcChain} onChange={(e) => setSrcChain(e.target.value)}>
            {chains.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          To chain
          <select value={dstChain} onChange={(e) => setDstChain(e.target.value)}>
            {chains.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row">
        <label>
          Amount
          <input
            type="text"
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder="0"
          />
        </label>
        <label>
          Slippage %
          <input
            type="number"
            step="0.1"
            min="0"
            max="50"
            value={slippage}
            onChange={(e) => setSlippage(Number(e.target.value))}
          />
        </label>
      </div>

      {loading && <p>Loading quote...</p>}
      {error && <p className="error">{error}</p>}
      {success && <p className="success">{success}</p>}

      {quote && (
        <div className="quote">
          <p>
            <strong>Provider:</strong> {quote.provider}
          </p>
          <p>
            <strong>Min received:</strong> {formatAmount(quote.minOutput)}
          </p>
          {effectiveRate !== null && (
            <p>
              <strong>Rate:</strong> {effectiveRate.toFixed(6)}
            </p>
          )}
          {quote.plan.length > 1 && (
            <div>
              <strong>Split route:</strong>
              <ul>
                {quote.plan.map((part, idx) => (
                  <li key={idx}>
                    {part.provider}: {formatAmount(part.amount)} -> {formatAmount(part.minOutput)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <button onClick={handleSubmit} disabled={!quote || submitting}>
        {submitting ? 'Submitting...' : 'Confirm bridge transfer'}
      </button>
    </div>
  );
};

export default CrossChainBridge;
