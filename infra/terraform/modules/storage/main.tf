/**
 * Storage module — backup bucket, encryption key, and the SQLite data volume.
 *
 * This module exists to make the *existing* backup tooling work without
 * modification. `scripts/automated-backup.sh` uploads to
 * `s3://$BACKUP_S3_BUCKET/{daily,weekly,monthly}/`, and
 * `scripts/backup-monitoring.sh` lists those prefixes and checks freshness. The
 * bucket, its lifecycle rules, and the IAM grants in the security module are
 * all shaped around what those scripts already do.
 *
 * The EBS volume is separate from the instance root on purpose: the SQLite
 * database must survive instance replacement. An immutable-infrastructure
 * deploy that recreated the instance would otherwise take the audit log with
 * it, which is exactly the failure `docs/backup-strategy.md` is written to
 * prevent.
 */

# ── Encryption key ───────────────────────────────────────────────────────────

resource "aws_kms_key" "main" {
  count = var.create_kms_key ? 1 : 0

  description             = "${var.name_prefix} — backups, secrets, and the data volume"
  deletion_window_in_days = var.kms_deletion_window_days
  enable_key_rotation     = true

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-key"
  })
}

resource "aws_kms_alias" "main" {
  count = var.create_kms_key ? 1 : 0

  name          = "alias/${var.name_prefix}"
  target_key_id = aws_kms_key.main[0].key_id
}

locals {
  kms_key_arn = var.create_kms_key ? aws_kms_key.main[0].arn : var.kms_key_arn
}

# ── Backup bucket ────────────────────────────────────────────────────────────

resource "aws_s3_bucket" "backups" {
  bucket = var.backup_bucket_name

  # Production keeps this FALSE so `terraform destroy` cannot remove the bucket
  # holding the audit-database backups. Development and staging set it true so
  # those environments can genuinely be torn down and recreated.
  force_destroy = var.backup_bucket_force_destroy

  tags = merge(var.tags, {
    Name = var.backup_bucket_name
  })
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket = aws_s3_bucket.backups.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id

  versioning_configuration {
    # Versioning is the defence against the failure mode a backup cannot
    # otherwise survive: a corrupted database being backed up *over* the last
    # good copy before anyone notices.
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    apply_server_side_encryption_by_default {
      # Backups are already encrypted client-side with AES-256-GCM by
      # automated-backup.sh. This is a second, independent layer so a bucket
      # misconfiguration alone does not expose plaintext.
      sse_algorithm     = local.kms_key_arn == null ? "AES256" : "aws:kms"
      kms_master_key_id = local.kms_key_arn
    }
    bucket_key_enabled = local.kms_key_arn != null
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  # Retention mirrors docs/backup-strategy.md exactly. If that document
  # changes, these must change with it.
  rule {
    id     = "daily-retention"
    status = "Enabled"

    filter {
      prefix = "daily/"
    }

    expiration {
      days = var.daily_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_retention_days
    }
  }

  rule {
    id     = "weekly-retention"
    status = "Enabled"

    filter {
      prefix = "weekly/"
    }

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }

    expiration {
      days = var.weekly_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_retention_days
    }
  }

  rule {
    id     = "monthly-retention"
    status = "Enabled"

    filter {
      prefix = "monthly/"
    }

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = 90
      storage_class = "GLACIER"
    }

    expiration {
      days = var.monthly_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_retention_days
    }
  }

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      # A backup upload interrupted partway leaves billable parts behind
      # indefinitely otherwise.
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "backups" {
  statement {
    sid    = "DenyUnencryptedTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:*"]
    resources = [aws_s3_bucket.backups.arn, "${aws_s3_bucket.backups.arn}/*"]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "backups" {
  bucket = aws_s3_bucket.backups.id
  policy = data.aws_iam_policy_document.backups.json

  depends_on = [aws_s3_bucket_public_access_block.backups]
}

# ── Data volume ──────────────────────────────────────────────────────────────

resource "aws_ebs_volume" "data" {
  count = var.create_data_volume ? 1 : 0

  availability_zone = var.data_volume_availability_zone
  size              = var.data_volume_size_gb
  type              = "gp3"
  encrypted         = true
  kms_key_id        = local.kms_key_arn

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-data"
    # Consumed by the AWS Backup selection below and by the recovery tooling,
    # which needs to find this volume without hard-coding its id.
    Backup = "true"
  })

  lifecycle {
    # The audit database lives here. Losing it to a routine attribute change
    # would be unrecoverable outside a restore, so replacement is refused.
    prevent_destroy = true
  }
}

resource "aws_dlm_lifecycle_policy" "data_snapshots" {
  count = var.create_data_volume && var.enable_volume_snapshots ? 1 : 0

  description        = "${var.name_prefix} — data volume snapshots"
  execution_role_arn = aws_iam_role.dlm[0].arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]

    target_tags = {
      Name = "${var.name_prefix}-data"
    }

    schedule {
      name = "daily-snapshots"

      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        # 03:00 UTC — offset from the backup script's own schedule so the two
        # do not contend for volume IO.
        times = ["03:00"]
      }

      retain_rule {
        count = var.snapshot_retention_count
      }

      copy_tags = true
    }
  }

  tags = var.tags
}

resource "aws_iam_role" "dlm" {
  count = var.create_data_volume && var.enable_volume_snapshots ? 1 : 0

  name_prefix = "${var.name_prefix}-dlm-"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "dlm.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "dlm" {
  count = var.create_data_volume && var.enable_volume_snapshots ? 1 : 0

  role       = aws_iam_role.dlm[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}
