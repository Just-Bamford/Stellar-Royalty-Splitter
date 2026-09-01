# Environment Configuration

Three environments, one template each. Templates hold **placeholders only** and
are committed; real values are never.

| Environment | Network | Template | Where real values live |
|---|---|---|---|
| Development | testnet | `.env.dev.example` | `backend/.env` / `frontend/.env` (gitignored) |
| Staging | testnet | `.env.staging.example` | GitHub Environment `staging` |
| Production | **mainnet** | `.env.prod.example` | GitHub Environment `production` (required reviewer) |

## Local setup

```bash
cp config/env/.env.dev.example backend/.env
# mirror the VITE_* keys into frontend/.env
./scripts/validate-env.sh
```

`validate-env.sh` reports only whether a key is present and valid — it never
prints a value, so it is safe to paste its output into an issue.

## How the environments differ

|  | dev | staging | production |
|---|---|---|---|
| `NODE_ENV` | `development` | `production` | `production` |
| `STELLAR_NETWORK` | testnet | testnet | mainnet |
| `FRONTEND_ORIGIN` | `http://localhost:5173` | exact https origin | exact https origin |
| Wildcard CORS (`*`) | allowed | refused | refused |
| `SIGNATURE_VERIFICATION_ENABLED` | `false` | `true` | `true` |
| `SECRETS_PROVIDER` | `env` | `env` | `aws` (or `vault`) |
| Deploy trigger | manual | automatic on `main` | manual + approval |

Staging deliberately mirrors production configuration while pointing at
testnet. The only intended difference is the network, so a release candidate
that behaves on staging is exercising the same CORS, signing, and error
handling it will meet in production.

## Secrets

Secrets are **never** committed, not even as an empty assignment with a real
value nearby. They are set per-environment in
*Settings → Environments → \<name\> → Environment secrets*:

| Key | Purpose |
|---|---|
| `SIGNING_KEY_FILE` | Path to the signing key file on the host |
| `ADMIN_ROTATE_TOKEN` | Bearer token guarding `POST /admin/rotate-key` |
| `AWS_SECRET_NAME`, `AWS_REGION` | When `SECRETS_PROVIDER=aws` |
| `VAULT_ADDR`, `VAULT_TOKEN`, `VAULT_SECRET_PATH` | When `SECRETS_PROVIDER=vault` |

Non-secret configuration (`STELLAR_NETWORK`, `SOROBAN_RPC_URL`, `HORIZON_URL`,
`FRONTEND_ORIGIN`, `STELLAR_IDENTITY`, `ROYALTY_CONTRACT_ID`) is set as
environment **variables**, not secrets — a contract address is public, and
masking it only makes deploy logs harder to read.

See [`backend/SECRETS_MANAGER.md`](../../backend/SECRETS_MANAGER.md) for the
managed-store integration.

## Adding a new configuration key

1. Add it to all three `*.example` templates with a comment explaining what it
   does and its default.
2. If it is required for the app to boot, add it to `REQUIRED_BACKEND_VARS` or
   `REQUIRED_FRONTEND_VARS` in `scripts/validate-env.sh`.
3. If the deploy workflow needs it, add it to the "Validate environment
   configuration" step in `.github/workflows/deploy.yml`.

## Guardrails

`.gitignore` ignores `.env`, `.env.*`, and the three `config/env/.env.<env>`
paths while explicitly re-including `*.example`, so filling in a template
in place cannot be committed by accident.

The production deploy job additionally refuses to run when `FRONTEND_ORIGIN`
is `*` or `STELLAR_NETWORK` is not `mainnet`, catching a misconfigured
environment before cutover rather than after.
