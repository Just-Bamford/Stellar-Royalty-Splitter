import React, { useEffect, useState } from 'react';

export interface StrategyStatus {
  name: string;
  balance?: string;
  debt?: string;
  apy?: string;
  yield?: { total: string } | null;
  urn?: string;
  rate?: string;
  spot?: string;
}

export interface DeFiStatus {
  strategies: StrategyStatus[];
}

export interface DeFiStrategiesProps {
  asset?: string;
  user?: string;
  ilk?: string;
  principal?: string;
  oldIndex?: string;
  apiBaseUrl?: string;
  onSwitch?: (from: string, to: string) => void | Promise<void>;
}

const DEFAULT_BASE = '/api/defi';

function formatAmount(value?: string) {
  if (!value) return '0';
  try {
    return BigInt(value).toString();
  } catch {
    return value;
  }
}

export const DeFiStrategies: React.FC<DeFiStrategiesProps> = ({
  asset,
  user,
  ilk,
  principal,
  oldIndex,
  apiBaseUrl = DEFAULT_BASE,
  onSwitch,
}) => {
  const [status, setStatus] = useState<DeFiStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (asset) params.set('asset', asset);
      if (user) params.set('user', user);
      if (ilk) params.set('Ilk', ilk);
      if (principal) params.set('principal', principal);
      if (oldIndex) params.set('oldIndex', oldIndex);
      const res = await fetch(`${apiBaseUrl}/strategies?${params.toString()}`);
      if (!res.ok) throw new Error(`Failed to load strategies: ${res.status}`);
      const data = (await res.json()) as DeFiStatus;
      setStatus(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [asset, user, ilk, principal, oldIndex, apiBaseUrl]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSwitch = async (from: string, to: string) => {
    if (onSwitch) {
      await onSwitch(from, to);
    }
    await load();
  };

  if (loading) return <div className="defi-strategies">Loading strategies...</div>;
  if (error) return <div className="defi-strategies error">{error}</div>;
  if (!status) return <div className="defi-strategies">No strategy data</div>;

  return (
    <div className="defi-strategies">
      <h1>DeFi Strategies</h1>
      <table>
        <thead>
          <tr>
            <th>Strategy</th>
            <th>Balance</th>
            <th>Debt</th>
            <th>APY</th>
            <th>Yield</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {status.strategies.map((strategy) => (
            <tr key={strategy.name}>
              <td>{strategy.name}</td>
              <td>{formatAmount(strategy.balance)}</td>
              <td>{formatAmount(strategy.debt)}</td>
              <td>{strategy.apy ?? '.'}</td>
              <td>{strategy.yield?.total ? formatAmount(strategy.yield.total) : '.'}</td>
              <td>
                <button type="button" onClick={() => handleSwitch(strategy.name, 'idle')}>
                  Exit
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default DeFiStrategies;
