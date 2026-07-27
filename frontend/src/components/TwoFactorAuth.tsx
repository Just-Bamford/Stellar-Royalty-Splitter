import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { api } from "../api";
import "./TwoFactorAuth.css";

interface TwoFactorSetupProps {
  walletAddress: string;
  onEnabled?: () => void;
}

export const TwoFactorSetup: React.FC<TwoFactorSetupProps> = ({
  walletAddress,
  onEnabled,
}) => {
  const [otpauthUrl, setOtpauthUrl] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function startSetup() {
    setLoading(true);
    setError(null);
    try {
      const response = await api.setupTwoFactor(walletAddress);
      setOtpauthUrl(response.data.otpauthUrl);
      setSecret(response.data.secret);
      setBackupCodes(response.data.backupCodes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start 2FA setup");
    } finally {
      setLoading(false);
    }
  }

  async function confirmSetup(event: React.FormEvent) {
    event.preventDefault();
    setConfirming(true);
    setError(null);
    try {
      const response = await api.confirmTwoFactor(walletAddress, code);
      localStorage.setItem("srs_2fa_session", response.data.sessionToken);
      localStorage.setItem("srs_2fa_wallet", walletAddress);
      onEnabled?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid authentication code");
    } finally {
      setConfirming(false);
    }
  }

  return (
    <section className="two-factor-card" aria-labelledby="two-factor-setup-heading">
      <h2 id="two-factor-setup-heading">Enable Two-Factor Authentication</h2>
      <p>
        Protect admin accounts with an authenticator app (Google Authenticator, Authy).
        Scan the QR code, store your backup codes, then confirm with a 6-digit code.
      </p>

      {!otpauthUrl ? (
        <button type="button" className="two-factor-primary" onClick={startSetup} disabled={loading}>
          {loading ? "Generating…" : "Start 2FA enrollment"}
        </button>
      ) : (
        <div className="two-factor-setup-grid">
          <div className="two-factor-qr">
            <QRCodeSVG value={otpauthUrl} size={180} />
            <p className="two-factor-secret">
              Manual key: <code>{secret}</code>
            </p>
          </div>

          <div>
            <h3>Backup codes</h3>
            <p className="two-factor-help">Store these somewhere safe. Each code works once.</p>
            <ul className="backup-code-list">
              {backupCodes.map((backupCode) => (
                <li key={backupCode}>
                  <code>{backupCode}</code>
                </li>
              ))}
            </ul>

            <form onSubmit={confirmSetup} className="two-factor-form">
              <label htmlFor="totp-confirm">Authenticator code</label>
              <input
                id="totp-confirm"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="123456"
                required
              />
              <button type="submit" className="two-factor-primary" disabled={confirming || code.length !== 6}>
                {confirming ? "Verifying…" : "Confirm and enable 2FA"}
              </button>
            </form>
          </div>
        </div>
      )}

      {error && (
        <div className="two-factor-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
};

interface TwoFactorChallengeProps {
  walletAddress: string;
  onVerified: () => void;
}

export const TwoFactorChallenge: React.FC<TwoFactorChallengeProps> = ({
  walletAddress,
  onVerified,
}) => {
  const [mode, setMode] = useState<"totp" | "backup">("totp");
  const [code, setCode] = useState("");
  const [backupCode, setBackupCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const response =
        mode === "totp"
          ? await api.verifyTwoFactor(walletAddress, code)
          : await api.recoverTwoFactor(walletAddress, backupCode);

      localStorage.setItem("srs_2fa_session", response.data.sessionToken);
      localStorage.setItem("srs_2fa_wallet", walletAddress);
      onVerified();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="two-factor-card two-factor-challenge" aria-labelledby="two-factor-challenge-heading">
      <h2 id="two-factor-challenge-heading">Two-factor verification required</h2>
      <p>Enter the 6-digit code from your authenticator app to continue to admin tools.</p>

      <div className="two-factor-mode-toggle" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "totp"}
          className={mode === "totp" ? "active" : ""}
          onClick={() => setMode("totp")}
        >
          Authenticator
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "backup"}
          className={mode === "backup" ? "active" : ""}
          onClick={() => setMode("backup")}
        >
          Backup code
        </button>
      </div>

      <form onSubmit={submit} className="two-factor-form">
        {mode === "totp" ? (
          <>
            <label htmlFor="totp-login">Authentication code</label>
            <input
              id="totp-login"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="123456"
              required
            />
          </>
        ) : (
          <>
            <label htmlFor="backup-login">Backup recovery code</label>
            <input
              id="backup-login"
              value={backupCode}
              onChange={(e) => setBackupCode(e.target.value.trim())}
              placeholder="XXXXX-XXXXX"
              required
            />
          </>
        )}
        <button type="submit" className="two-factor-primary" disabled={loading}>
          {loading ? "Verifying…" : "Verify and continue"}
        </button>
      </form>

      {error && (
        <div className="two-factor-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
};

interface TwoFactorManagementProps {
  walletAddress: string;
}

export const TwoFactorManagement: React.FC<TwoFactorManagementProps> = ({ walletAddress }) => {
  const [enabled, setEnabled] = useState(false);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const response = await api.getTwoFactorStatus(walletAddress);
      setEnabled(response.data.enabled);
      setPending(response.data.pending);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load 2FA status");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [walletAddress]);

  async function disable(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    try {
      await api.disableTwoFactor(walletAddress, { code });
      localStorage.removeItem("srs_2fa_session");
      localStorage.removeItem("srs_2fa_wallet");
      setMessage("Two-factor authentication disabled.");
      setCode("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disable 2FA");
    }
  }

  if (loading) return <p>Loading 2FA settings…</p>;

  return (
    <section className="two-factor-card" aria-labelledby="two-factor-manage-heading">
      <h2 id="two-factor-manage-heading">Admin 2FA</h2>
      <p>
        Status:{" "}
        <strong>{enabled ? "Enabled" : pending ? "Pending confirmation" : "Disabled"}</strong>
      </p>

      {!enabled && <TwoFactorSetup walletAddress={walletAddress} onEnabled={refresh} />}

      {enabled && (
        <form onSubmit={disable} className="two-factor-form">
          <label htmlFor="totp-disable">Enter current code to disable 2FA</label>
          <input
            id="totp-disable"
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            required
          />
          <button type="submit" className="two-factor-danger">
            Disable 2FA
          </button>
        </form>
      )}

      {message && <div className="two-factor-success">{message}</div>}
      {error && (
        <div className="two-factor-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
};
