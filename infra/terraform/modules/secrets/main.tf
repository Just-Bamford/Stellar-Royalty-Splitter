/**
 * Secrets module — Secrets Manager entries for the values that must never be
 * committed.
 *
 * The important property here is that Terraform creates the secret *container*
 * but not its value. `aws_secretsmanager_secret_version` is written once with a
 * placeholder and then ignored forever via `lifecycle.ignore_changes`, so the
 * real value is set out-of-band — by an operator, or by the rotation path in
 * `backend/src/secrets-manager.js` — and never appears in a .tf file, a plan,
 * or the state file.
 *
 * This is what satisfies #870's "secrets are supplied through secure
 * mechanisms rather than committed files". Terraform state is not a safe place
 * for a signing key: it is stored in S3, read by CI, and diffed in plan output.
 */

resource "aws_secretsmanager_secret" "signing_key" {
  count = var.create_signing_key_secret ? 1 : 0

  name_prefix = "${var.name_prefix}/signing-key-"
  description = "Stellar server signing key. Read at startup by backend/src/secrets-manager.js."
  kms_key_id  = var.kms_key_arn

  recovery_window_in_days = var.recovery_window_days

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-signing-key"
  })
}

resource "aws_secretsmanager_secret_version" "signing_key" {
  count = var.create_signing_key_secret ? 1 : 0

  secret_id = aws_secretsmanager_secret.signing_key[0].id

  # Deliberately a placeholder. The real key is written out-of-band with:
  #   aws secretsmanager put-secret-value \
  #     --secret-id <id> --secret-string '{"signingKey":"S..."}'
  # See infra/terraform/README.md.
  secret_string = jsonencode({
    signingKey = "PLACEHOLDER_SET_OUT_OF_BAND"
  })

  lifecycle {
    # Without this, every plan would show a diff against the real value and
    # every apply would overwrite the live key with the placeholder.
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret" "backup_encryption_key" {
  count = var.create_backup_key_secret ? 1 : 0

  name_prefix = "${var.name_prefix}/backup-encryption-key-"
  description = "Passphrase for AES-256-GCM backup encryption. Read by scripts/automated-backup.sh as BACKUP_ENCRYPTION_KEY."
  kms_key_id  = var.kms_key_arn

  recovery_window_in_days = var.recovery_window_days

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-backup-encryption-key"
  })
}

resource "aws_secretsmanager_secret_version" "backup_encryption_key" {
  count = var.create_backup_key_secret ? 1 : 0

  secret_id     = aws_secretsmanager_secret.backup_encryption_key[0].id
  secret_string = "PLACEHOLDER_SET_OUT_OF_BAND"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret" "admin_rotate_token" {
  count = var.create_admin_token_secret ? 1 : 0

  name_prefix = "${var.name_prefix}/admin-rotate-token-"
  description = "Bearer token for POST /admin/rotate-key."
  kms_key_id  = var.kms_key_arn

  recovery_window_in_days = var.recovery_window_days

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-admin-rotate-token"
  })
}

resource "aws_secretsmanager_secret_version" "admin_rotate_token" {
  count = var.create_admin_token_secret ? 1 : 0

  secret_id     = aws_secretsmanager_secret.admin_rotate_token[0].id
  secret_string = "PLACEHOLDER_SET_OUT_OF_BAND"

  lifecycle {
    ignore_changes = [secret_string]
  }
}
