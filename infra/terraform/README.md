# Infrastructure as Code

Terraform configuration for the Stellar Royalty Splitter deployment (#870).

Before this existed, infrastructure was provisioned by hand following
[`docs/operator-runbook.md`](../../docs/operator-runbook.md). That works once;
it does not survive being reviewed, reproduced, audited, or rolled back. This
directory is the single version-controlled definition of what the deployment
consists of.

---

## What it provisions

The architecture here is the one the application already assumes — it was
derived from what the code and scripts do, not chosen fresh:

| Signal in the repository | What it implies |
|---|---|
| `scripts/automated-backup.sh` uploads to S3 with `BACKUP_S3_REGION=us-east-1` | AWS, S3 backups |
| `backend/src/secrets-manager.js` supports `aws` and auto-detects it | AWS Secrets Manager |
| `DATABASE_PATH` points at a SQLite file | A filesystem, not a managed database |
| `docs/operator-runbook.md` starts the API under `pm2` | A long-lived host, not a container platform |
| `frontend/` builds to a static `dist/` | Object storage plus a CDN |
| `backend/src/metrics.js` exposes Prometheus metrics | An existing metrics story to preserve |

```
                    Internet
                        │
          ┌─────────────┴─────────────┐
          │                           │
    CloudFront                  Application LB
   (frontend, S3)              (public subnets)
                                       │
                              ┌────────┴────────┐
                              │  EC2 + pm2      │  private subnet
                              │  Express API    │  no public IP
                              └────────┬────────┘
                                       │
                    ┌──────────────────┼──────────────────┐
                    │                  │                  │
              EBS (SQLite)      Secrets Manager      S3 (backups)
```

**One instance, by design.** The application writes to a single SQLite file on
a single EBS volume. Two instances would corrupt it, so `max_size` is validated
to be exactly 1. The auto-scaling group is there for *recovery* — a failed
health check replaces the instance — not for scale. Removing that ceiling means
migrating to a networked database first, which is a larger change than this
one.

---

## Layout

```
infra/terraform/
├── modules/                 Reusable, environment-agnostic components
│   ├── network/             VPC, subnets, NAT, routing, VPC endpoints
│   ├── security/            Security groups and the instance IAM role
│   ├── storage/             Backup bucket, KMS key, EBS data volume
│   ├── secrets/             Secrets Manager entries (containers, not values)
│   ├── compute/             ALB, launch template, auto-scaling group
│   ├── frontend/            S3 origin and CloudFront distribution
│   └── monitoring/          Log group, alarms, dashboard
└── environments/            Environment-specific composition
    ├── dev/
    ├── staging/
    └── prod/
```

No module contains an environment-specific value. Everything that differs
between dev, staging, and production is a variable set in the environment,
which is what lets a change be validated in development and behave the same in
production.

---

## Quick start

### 1. Bootstrapping remote state

State must exist somewhere before Terraform can manage anything, so the state
bucket and lock table are created once, outside Terraform. This is the only
manual step, and it is deliberate — a Terraform configuration that manages its
own backend cannot be destroyed and recreated cleanly.

```bash
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGION=us-east-1
BUCKET="srs-terraform-state-${ACCOUNT_ID}"

aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"

# Versioning is what makes a corrupted or truncated state file recoverable.
aws s3api put-bucket-versioning \
  --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption \
  --bucket "$BUCKET" \
  --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

# State contains resource attributes and must never be public.
aws s3api put-public-access-block \
  --bucket "$BUCKET" \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# The lock table. Without it, two concurrent applies can corrupt state.
aws dynamodb create-table \
  --table-name srs-terraform-locks \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region "$REGION"
```

### 2. Initialise an environment

```bash
cd infra/terraform/environments/dev

cp backend.hcl.example backend.hcl
cp terraform.tfvars.example terraform.tfvars
# Edit both: backend.hcl needs your account id, terraform.tfvars is worth reading through.

terraform init -backend-config=backend.hcl
```

### 3. Plan and apply

```bash
terraform plan     # read this properly — it is the review artifact
terraform apply
```

### 4. Supply the secrets

Terraform creates the secret *containers* with placeholder values and then
ignores their contents forever. The real values are written out-of-band, so
they never appear in a `.tf` file, a plan, or the state file:

```bash
SECRET_NAME="$(terraform output -raw signing_key_secret_name)"

aws secretsmanager put-secret-value \
  --secret-id "$SECRET_NAME" \
  --secret-string "{\"signingKey\":\"S...\"}"
```

Then restart the application so it re-reads them, or use the running service's
`POST /admin/rotate-key`.

### 5. Deploy the application

Terraform does not deploy code — see "Scope" below.

```bash
# Frontend
cd frontend && npm ci && npm run build
aws s3 sync dist/ "s3://$(terraform -chdir=../infra/terraform/environments/dev output -raw frontend_bucket)/" --delete
aws cloudfront create-invalidation \
  --distribution-id "$(terraform -chdir=../infra/terraform/environments/dev output -raw frontend_distribution_id)" \
  --paths '/index.html'
```

For the backend, connect with Session Manager (there is no SSH access and no
key pair to manage) and deploy per `docs/operator-runbook.md`:

```bash
aws ssm start-session --target <instance-id>
```

---

## Scope

**Terraform provisions infrastructure. It does not deploy application code.**

The instance bootstrap installs Node, pm2, and the CloudWatch agent, mounts the
data volume, and writes the environment file. It deliberately does not clone
the repository or start the application.

The reason is that conflating the two makes both worse: every infrastructure
change becomes a code deploy, and every code deploy becomes an instance
replacement. Keeping them separate means a security-group fix does not restart
the API, and a code release does not risk the network configuration.

Consequently, a freshly applied environment has a **failing health check** until
the application is deployed onto it. That is expected, and the bootstrap log
says so.

---

## State management

| Aspect | Choice | Why |
|---|---|---|
| Backend | S3 | Already the storage provider; no new dependency. |
| Locking | DynamoDB | Prevents two applies corrupting state. Required — CI and a human can otherwise collide. |
| Encryption | SSE-S3, enforced | State contains resource attributes and must not sit in plaintext. |
| Versioning | Enabled | The only recovery path for a corrupted or truncated state file. |
| Isolation | One key per environment | A mistake in development cannot touch production state. |
| Configuration | `backend.hcl`, gitignored | The bucket name embeds an account id. Not secret, but account-specific. |

### State is sensitive

Even though no secret *value* is written by this configuration, state records
every resource attribute — ARNs, security group rules, subnet layout. Treat
read access to the state bucket as equivalent to read access to the
infrastructure description.

### If a lock is stuck

An interrupted apply can leave the lock held. Confirm nothing is actually
running first — force-unlocking a live apply is how state gets corrupted:

```bash
terraform force-unlock <LOCK_ID>
```

---

## Secrets

Nothing here writes a real secret value.

`aws_secretsmanager_secret_version` is created once with a placeholder and then
marked `ignore_changes`, so:

- no secret is in the repository;
- no secret is in `terraform plan` output, which CI posts on pull requests;
- no secret is in the state file;
- rotating a secret does not require a Terraform run, and a Terraform run does
  not overwrite a rotated secret.

The application reads them at runtime through
`backend/src/secrets-manager.js`, which already supports AWS Secrets Manager
and auto-detects it from `AWS_SECRET_NAME`.

Non-secret configuration goes to SSM Parameter Store instead, under
`/<name_prefix>/config`, and is read into the instance environment file at
boot. That means changing `LOG_LEVEL` is a parameter update and a restart, not
an infrastructure apply.

---

## Environments

| | dev | staging | prod |
|---|---|---|---|
| CIDR | `10.10.0.0/16` | `10.20.0.0/16` | `10.30.0.0/16` |
| AZs | 2 | 2 | 3 |
| NAT gateways | 1 shared | 1 shared | 1 per AZ |
| Instance | `t3.small` | `t3.small` | `t3.medium` |
| Data volume | 10 GB | 20 GB | 100 GB |
| TLS certificate | optional | **required** | **required** |
| Signature verification | off | **required on** | **required on** |
| Stellar network | testnet (enforced) | testnet (enforced) | mainnet |
| Flow logs | off | 14 days | 90 days |
| Log retention | 7 days | 30 days | 90 days |
| Backup retention (D/W/M) | 3 / 7 / 30 | 7 / 14 / 60 | 7 / 30 / 365 |
| EBS snapshots | off | 3 | 14 |
| Deletion protection | off | off | **on** |
| Destroyable | yes | yes | deliberately awkward |
| CloudFront | `PriceClass_100` | `PriceClass_100` | `PriceClass_All` |

Several production and staging settings are enforced by `validation` blocks
rather than by convention, so a misconfiguration fails at plan time rather than
becoming an incident:

- `certificate_arn` must be a real ACM ARN — no plain HTTP.
- `signature_verification_enabled` must be `true`, because
  `backend/.env.example` states it is mandatory on mainnet.
- `allowed_ingress_cidrs` has no default. `["0.0.0.0/0"]` is a legitimate
  answer for a public API; the point is that it is stated rather than
  inherited.
- `alert_email_addresses` must be non-empty. Alarms nobody receives are not
  monitoring.
- dev and staging must use testnet, so an environment that gets destroyed and
  recreated routinely can never move real funds.

**Staging is deliberately not relaxed on safety properties.** It is smaller and
cheaper than production, but keeps the same TLS, signature-verification, and
alarm-threshold requirements — a rehearsal that skips them rehearses the wrong
thing.

---

## Verifying a change

Every module and environment validates with no AWS access at all, which is what
the CI `validate` job relies on:

```bash
cd infra/terraform
terraform fmt -check -recursive

for dir in modules/*/ environments/*/; do
  echo "── $dir"
  ( cd "$dir" && terraform init -backend=false >/dev/null && terraform validate )
done
```

`terraform plan` needs real credentials; CI runs it for development via OIDC
when `AWS_ROLE_ARN` is configured, and skips it — rather than failing — when it
is not, so fork pull requests are not blocked by a check they cannot satisfy.

---

## Destroying and recreating

Development and staging are meant to be disposable, and exercising that is how
the disaster-recovery procedures stay honest:

```bash
cd infra/terraform/environments/dev
terraform destroy
terraform apply
```

Two things deliberately resist this:

- **`prevent_destroy` on the data volume.** The audit database lives there.
  Removing it requires editing `modules/storage/main.tf` first, which is a
  reviewable act rather than an accident.
- **`force_destroy = false` on the production backup bucket.** `destroy` will
  refuse while it holds objects.

Production additionally has ALB deletion protection enabled. Tearing it down is
possible, but not by accident.

---

## Cost

Rough monthly figures for `us-east-1`, excluding data transfer:

| | dev | staging | prod |
|---|---|---|---|
| EC2 | ~$15 | ~$15 | ~$30 |
| NAT gateway | ~$32 | ~$32 | ~$97 |
| ALB | ~$16 | ~$16 | ~$16 |
| EBS | ~$1 | ~$2 | ~$8 |
| S3, CloudFront, CloudWatch | ~$5 | ~$8 | ~$25 |
| **Total** | **~$70** | **~$75** | **~$180** |

The NAT gateway is the single largest line in every environment, and in
production it is the majority of the difference. Two levers matter:

- `one_nat_gateway_per_az` — set false in production to save roughly $65/month
  at the cost of a single point of failure on the path to Horizon and Soroban
  RPC.
- `desired_capacity = 0` in development parks the instance overnight without
  destroying anything; the data volume and its contents survive.

---

## Related documentation

- [`docs/operator-runbook.md`](../../docs/operator-runbook.md) — day-to-day operations
- [`docs/backup-strategy.md`](../../docs/backup-strategy.md) — the retention policy these lifecycle rules implement
- [`docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md) — contract deployment
- [`backend/.env.example`](../../backend/.env.example) — every setting the application reads
