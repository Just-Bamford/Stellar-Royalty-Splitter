/**
 * Compliance audit trail — off-box immutable archive and tamper alarms (#938).
 *
 * The application keeps an append-only, hash-chained trail in its own SQLite
 * file (backend/src/database/audit-trail-immutable.js). On the host, SQLite
 * triggers stop the application from rewriting it, and the hash chain makes
 * any out-of-band edit detectable — but someone with root on the box could
 * still replace the file wholesale. This file closes that gap:
 *
 *   - An S3 bucket with Object Lock in COMPLIANCE mode. Objects cannot be
 *     overwritten or deleted by anyone, including the root account, until
 *     their retention (7 years by default) expires.
 *   - A daily job that exports the previous day's entries — with the chain's
 *     head hash and verification result — and writes them into that bucket.
 *     Each export is an off-box checkpoint: if the local chain is later
 *     rebuilt, it will no longer match the archived head hashes.
 *   - Alarms on the application's `audit_trail_integrity_failure` and
 *     `audit_trail_write_failure` log events, and on verification going quiet.
 *
 * The instance may only PUT into the archive. It holds no delete permission,
 * and Object Lock would refuse the delete even if it did.
 *
 * CloudTrail/Datadog forwarding of the archive bucket's data events is assumed
 * to exist organisation-wide (out of scope for #938).
 */

variable "enable_audit_trail_service" {
  description = "Create the WORM audit archive, the daily export job, and the tamper alarms."
  type        = bool
  default     = true
}

variable "audit_retention_days" {
  description = "Object Lock retention for archived audit exports. SOX §802 requires 7 years."
  type        = number
  default     = 2557

  validation {
    condition     = var.audit_retention_days >= 2557
    error_message = "audit_retention_days must be at least 2557 (7 years) to meet SOX/FINRA retention."
  }
}

variable "audit_object_lock_mode" {
  description = "COMPLIANCE (nobody can shorten retention or delete) or GOVERNANCE (principals with s3:BypassGovernanceRetention can). Use COMPLIANCE in production."
  type        = string
  default     = "COMPLIANCE"

  validation {
    condition     = contains(["COMPLIANCE", "GOVERNANCE"], var.audit_object_lock_mode)
    error_message = "audit_object_lock_mode must be COMPLIANCE or GOVERNANCE."
  }
}

variable "audit_archive_kms_key_arn" {
  description = "CMK for the archive (the environment's `kms_key_arn` output). Null uses SSE-S3."
  type        = string
  default     = null
}

variable "app_log_group_name" {
  description = "The environment's `log_group_name` output — where the API's JSON logs land."
  type        = string
  default     = ""
}

variable "audit_export_schedule" {
  description = "When the daily audit export runs (UTC)."
  type        = string
  default     = "cron(30 0 * * ? *)"
}

locals {
  audit_enabled        = var.enable_audit_trail_service
  audit_archive_bucket = "${var.name_prefix}-audit-archive-${data.aws_caller_identity.current.account_id}"
}

data "aws_caller_identity" "current" {}

# ── WORM archive ─────────────────────────────────────────────────────────────

resource "aws_s3_bucket" "audit_archive" {
  count = local.audit_enabled ? 1 : 0

  bucket = local.audit_archive_bucket
  # Object Lock can only be enabled when a bucket is created.
  object_lock_enabled = true
  # Never force_destroy: locked objects cannot be deleted anyway, and trying
  # would only leave a half-destroyed state.
  force_destroy = false
}

resource "aws_s3_bucket_versioning" "audit_archive" {
  count = local.audit_enabled ? 1 : 0

  bucket = aws_s3_bucket.audit_archive[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "audit_archive" {
  count = local.audit_enabled ? 1 : 0

  bucket = aws_s3_bucket.audit_archive[0].id

  rule {
    default_retention {
      mode = var.audit_object_lock_mode
      days = var.audit_retention_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.audit_archive]
}

resource "aws_s3_bucket_public_access_block" "audit_archive" {
  count = local.audit_enabled ? 1 : 0

  bucket                  = aws_s3_bucket.audit_archive[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit_archive" {
  count = local.audit_enabled ? 1 : 0

  bucket = aws_s3_bucket.audit_archive[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.audit_archive_kms_key_arn == null ? "AES256" : "aws:kms"
      kms_master_key_id = var.audit_archive_kms_key_arn
    }
    bucket_key_enabled = var.audit_archive_kms_key_arn != null
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "audit_archive" {
  count = local.audit_enabled ? 1 : 0

  bucket = aws_s3_bucket.audit_archive[0].id

  rule {
    id     = "archive-then-expire"
    status = "Enabled"

    filter {}

    # Exports are written once and read almost never — at audit time.
    transition {
      days          = 90
      storage_class = "GLACIER_IR"
    }

    # Retention is what Object Lock enforces; expiry just stops paying for
    # the object the day after it is allowed to go.
    expiration {
      days = var.audit_retention_days + 1
    }

    noncurrent_version_expiration {
      noncurrent_days = var.audit_retention_days + 1
    }
  }

  depends_on = [aws_s3_bucket_versioning.audit_archive]
}

data "aws_iam_policy_document" "audit_archive" {
  count = local.audit_enabled ? 1 : 0

  statement {
    sid    = "DenyUnencryptedTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:*"]
    resources = [aws_s3_bucket.audit_archive[0].arn, "${aws_s3_bucket.audit_archive[0].arn}/*"]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # Belt and braces on top of Object Lock: nobody may even attempt to loosen
  # retention or remove versions through this bucket's policy surface.
  statement {
    sid    = "DenyRetentionTampering"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = [
      "s3:BypassGovernanceRetention",
      "s3:PutObjectRetention",
      "s3:PutObjectLegalHold",
      "s3:DeleteObjectVersion",
      "s3:PutBucketObjectLockConfiguration",
    ]
    resources = [aws_s3_bucket.audit_archive[0].arn, "${aws_s3_bucket.audit_archive[0].arn}/*"]
  }
}

resource "aws_s3_bucket_policy" "audit_archive" {
  count = local.audit_enabled ? 1 : 0

  bucket = aws_s3_bucket.audit_archive[0].id
  policy = data.aws_iam_policy_document.audit_archive[0].json

  depends_on = [aws_s3_bucket_public_access_block.audit_archive, aws_s3_bucket_object_lock_configuration.audit_archive]
}

# The instance may add exports. It may not delete, overwrite retention, or list.
data "aws_iam_policy_document" "audit_archive_writer" {
  count = local.audit_enabled ? 1 : 0

  statement {
    sid       = "AppendAuditExports"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.audit_archive[0].arn}/*"]
  }

  dynamic "statement" {
    for_each = var.audit_archive_kms_key_arn == null ? [] : [var.audit_archive_kms_key_arn]

    content {
      sid       = "EncryptAuditExports"
      actions   = ["kms:GenerateDataKey"]
      resources = [statement.value]
    }
  }
}

resource "aws_iam_role_policy" "audit_archive_writer" {
  count = local.audit_enabled && var.instance_role_name != "" ? 1 : 0

  name   = "audit-archive-append"
  role   = var.instance_role_name
  policy = data.aws_iam_policy_document.audit_archive_writer[0].json
}

# ── Daily export to the archive ──────────────────────────────────────────────

resource "aws_cloudwatch_event_rule" "audit_export" {
  count = local.audit_enabled ? 1 : 0

  name                = "${var.name_prefix}-audit-export"
  description         = "Daily SOX export of the immutable audit trail into the Object Lock archive (#938)"
  schedule_expression = var.audit_export_schedule
}

resource "aws_cloudwatch_event_target" "audit_export" {
  count = local.audit_enabled ? 1 : 0

  rule     = aws_cloudwatch_event_rule.audit_export[0].name
  arn      = local.run_shell_document_arn
  role_arn = aws_iam_role.scheduled_jobs[0].arn

  # Exports yesterday (UTC) via the admin API on localhost, then uploads with
  # the report's own SHA-256 as object metadata. `set -o pipefail` + `curl -f`
  # make a failed export fail the Run Command invocation visibly.
  input = jsonencode({
    commands = [
      join(" ", [
        "sudo -u srs bash -lc '${local.app_shell_prefix} set -o pipefail &&",
        "FROM=$(date -u -d yesterday +%Y-%m-%dT00:00:00Z) && TO=$(date -u +%Y-%m-%dT00:00:00Z) &&",
        "OUT=$(mktemp) && HDR=$(mktemp) &&",
        "curl -fsS -D \"$HDR\" -H \"Authorization: Bearer $ADMIN_ROTATE_TOKEN\"",
        "\"http://127.0.0.1:$${PORT:-3001}/admin/audit-trail/export?standard=SOX&format=json&from=$FROM&to=$TO\" -o \"$OUT\" &&",
        "SHA=$(grep -i ^x-report-sha256: \"$HDR\" | tr -d \"\\r\" | cut -d\" \" -f2) &&",
        "aws s3 cp \"$OUT\" \"s3://${local.audit_archive_bucket}/sox/$(date -u -d yesterday +%Y/%m/%d).json\"",
        "--metadata report-sha256=$SHA --only-show-errors --region ${data.aws_region.current.name} &&",
        "rm -f \"$OUT\" \"$HDR\"'",
      ]),
    ]
    executionTimeout = ["900"]
  })

  run_command_targets {
    key    = "tag:Name"
    values = [local.instance_name_tag]
  }
}

# ── Tamper and health alarms (from the API's structured logs) ─────────────────

locals {
  audit_log_metrics = local.audit_enabled && var.app_log_group_name != "" ? {
    AuditTrailIntegrityFailures = "{ $.event = \"audit_trail_integrity_failure\" }"
    AuditTrailWriteFailures     = "{ $.event = \"audit_trail_write_failure\" }"
    AuditTrailCheckpoints       = "{ $.event = \"audit_trail_checkpoint\" }"
  } : {}
}

resource "aws_cloudwatch_log_metric_filter" "audit_trail" {
  for_each = local.audit_log_metrics

  name           = "${var.name_prefix}-${each.key}"
  log_group_name = var.app_log_group_name
  pattern        = each.value

  metric_transformation {
    name          = each.key
    namespace     = var.metrics_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "audit_trail_tampered" {
  count = contains(keys(local.audit_log_metrics), "AuditTrailIntegrityFailures") ? 1 : 0

  alarm_name          = "${var.name_prefix}-audit-trail-tampered"
  alarm_description   = "CRITICAL: the immutable audit trail's hash chain failed verification — an entry was modified, removed or reordered outside the application. Treat as a security incident; preserve the host and compare with the archived exports in s3://${local.audit_archive_bucket} (#938)."
  namespace           = var.metrics_namespace
  metric_name         = "AuditTrailIntegrityFailures"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alert_topic_arn]

  depends_on = [aws_cloudwatch_log_metric_filter.audit_trail]
}

resource "aws_cloudwatch_metric_alarm" "audit_trail_write_failures" {
  count = contains(keys(local.audit_log_metrics), "AuditTrailWriteFailures") ? 1 : 0

  alarm_name          = "${var.name_prefix}-audit-trail-write-failures"
  alarm_description   = "State changes are not reaching the immutable audit trail — they are missing from the compliance record. Check disk and permissions on AUDIT_TRAIL_DB_PATH (#938)."
  namespace           = var.metrics_namespace
  metric_name         = "AuditTrailWriteFailures"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alert_topic_arn]

  depends_on = [aws_cloudwatch_log_metric_filter.audit_trail]
}

resource "aws_cloudwatch_metric_alarm" "audit_trail_unverified" {
  count = contains(keys(local.audit_log_metrics), "AuditTrailCheckpoints") ? 1 : 0

  alarm_name          = "${var.name_prefix}-audit-trail-unverified"
  alarm_description   = "No successful audit-trail verification in 3 hours — periodic tamper detection is not running (#938)."
  namespace           = var.metrics_namespace
  metric_name         = "AuditTrailCheckpoints"
  statistic           = "Sum"
  period              = 10800
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [var.alert_topic_arn]

  depends_on = [aws_cloudwatch_log_metric_filter.audit_trail]
}

output "audit_archive_bucket" {
  description = "Object Lock bucket holding the daily audit-trail exports."
  value       = local.audit_enabled ? aws_s3_bucket.audit_archive[0].id : null
}
