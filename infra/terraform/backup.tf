/**
 * Backup automation, recovery testing and freshness alarms (#937).
 *
 * The bucket itself — versioning, KMS encryption, TLS-only policy, lifecycle —
 * lives in modules/storage. This file schedules the jobs that use it and the
 * alarms that prove they ran:
 *
 *   every 15 min   backup-manager.js backup --type pitr     → RPO < 15 minutes
 *   daily 02:00    backup-manager.js backup --type daily    → retained history
 *   every 15 min   backup-manager.js check-freshness        → BackupAgeSeconds metric
 *   weekly Sun 04:00  recovery-test.sh --install on the recovery-test (staging) instance
 *
 * Targets (docs/backup-strategy.md):
 *   RPO < 15 minutes — bounded by the PITR interval; verified weekly by the
 *                      recovery test measuring the largest snapshot gap.
 *   RTO < 1 hour     — measured weekly end to end, service restart included.
 */

variable "enable_backup_automation" {
  description = "Schedule backups, freshness checks and the weekly recovery test."
  type        = bool
  default     = true
}

variable "backup_bucket_name" {
  description = "The environment's `backup_bucket` output."
  type        = string
  default     = ""
}

variable "backup_kms_key_arn" {
  description = "CMK for SSE-KMS on uploaded backups (the environment's `kms_key_arn` output). Null uses the bucket default."
  type        = string
  default     = null
}

variable "backup_encryption_key_parameter" {
  description = "SSM SecureString parameter holding BACKUP_ENCRYPTION_KEY. Read on the instance at run time so the key never appears in an EventBridge payload."
  type        = string
  default     = ""
}

variable "pitr_interval_minutes" {
  description = "Interval between point-in-time snapshots. This is the RPO."
  type        = number
  default     = 15

  validation {
    condition     = var.pitr_interval_minutes >= 5 && var.pitr_interval_minutes <= 15
    error_message = "pitr_interval_minutes must be between 5 and 15 to meet the 15-minute RPO."
  }
}

variable "daily_backup_schedule" {
  description = "EventBridge schedule for the retained daily backup (UTC)."
  type        = string
  default     = "cron(0 2 * * ? *)"
}

variable "recovery_test_schedule" {
  description = "EventBridge schedule for the weekly recovery test (UTC)."
  type        = string
  default     = "cron(0 4 ? * SUN *)"
}

variable "recovery_test_instance_name_tag" {
  description = "Name tag of the instance that runs the recovery test and receives the restored database — the staging app instance, never production. Empty disables the weekly test in this stack."
  type        = string
  default     = ""

  validation {
    condition     = !can(regex("(?i)(^|-)prod(-|$)", var.recovery_test_instance_name_tag))
    error_message = "The recovery test installs a restored database; it must not target a production instance."
  }
}

variable "recovery_test_instance_role_name" {
  description = "IAM role of the recovery-test instance. It is granted read-only access to this environment's backups, key parameter and CMK so it can restore them. Empty when the test runs on the environment's own instance."
  type        = string
  default     = ""
}

variable "rto_target_seconds" {
  description = "Recovery time objective checked by the recovery test and its alarm."
  type        = number
  default     = 3600
}

locals {
  backup_enabled = var.enable_backup_automation && var.backup_bucket_name != ""

  # BACKUP_ENVIRONMENT is the environment whose backups these are, so a
  # recovery test of production backups run on staging still reports under
  # Environment=prod — the alarms below watch that dimension.
  backup_env = join(" ", compact([
    "AWS_DEFAULT_REGION=${data.aws_region.current.name}",
    "BACKUP_S3_BUCKET=${var.backup_bucket_name}",
    "BACKUP_S3_REGION=${data.aws_region.current.name}",
    var.backup_kms_key_arn == null ? "" : "BACKUP_S3_KMS_KEY_ID=${var.backup_kms_key_arn}",
    "BACKUP_METRICS_NAMESPACE=${var.metrics_namespace}",
    "BACKUP_ENVIRONMENT=${var.environment}",
  ]))

  backup_key_fetch = var.backup_encryption_key_parameter == "" ? "" : "export BACKUP_ENCRYPTION_KEY=\"$(aws ssm get-parameter --with-decryption --name ${var.backup_encryption_key_parameter} --query Parameter.Value --output text)\" &&"

  backup_jobs = local.backup_enabled ? {
    pitr = {
      description = "Point-in-time snapshot every ${var.pitr_interval_minutes} minutes (RPO)"
      schedule    = "rate(${var.pitr_interval_minutes} minutes)"
      command     = "node infra/backup-manager.js backup --type pitr"
      timeout     = 900
      target_tag  = local.instance_name_tag
    }
    daily = {
      description = "Retained daily encrypted backup"
      schedule    = var.daily_backup_schedule
      command     = "node infra/backup-manager.js backup --type daily"
      timeout     = 3600
      target_tag  = local.instance_name_tag
    }
    freshness = {
      description = "Backup freshness check (publishes BackupAgeSeconds)"
      schedule    = "rate(15 minutes)"
      command     = "node infra/backup-manager.js check-freshness"
      timeout     = 300
      target_tag  = local.instance_name_tag
    }
  } : {}

  recovery_jobs = local.backup_enabled && var.recovery_test_instance_name_tag != "" ? {
    recovery-test = {
      description = "Weekly restore of the newest backup into staging, with integrity and RPO/RTO verification"
      schedule    = var.recovery_test_schedule
      command     = "RECOVERY_ENVIRONMENT=${var.environment == "prod" ? "staging" : var.environment} RTO_TARGET_SECONDS=${var.rto_target_seconds} infra/recovery-test.sh --install"
      timeout     = var.rto_target_seconds + 600
      target_tag  = var.recovery_test_instance_name_tag
    }
  } : {}
}

resource "aws_cloudwatch_event_rule" "backup" {
  for_each = merge(local.backup_jobs, local.recovery_jobs)

  name                = "${var.name_prefix}-${each.key}"
  description         = each.value.description
  schedule_expression = each.value.schedule
}

resource "aws_cloudwatch_event_target" "backup" {
  for_each = aws_cloudwatch_event_rule.backup

  rule     = each.value.name
  arn      = local.run_shell_document_arn
  role_arn = aws_iam_role.scheduled_jobs[0].arn

  input = jsonencode({
    commands = [
      "sudo -u srs bash -lc '${local.app_shell_prefix} ${local.backup_key_fetch} ${local.backup_env} ${merge(local.backup_jobs, local.recovery_jobs)[each.key].command}'",
    ]
    executionTimeout = [tostring(merge(local.backup_jobs, local.recovery_jobs)[each.key].timeout)]
  })

  run_command_targets {
    key    = "tag:Name"
    values = [merge(local.backup_jobs, local.recovery_jobs)[each.key].target_tag]
  }
}

# ── Permissions ──────────────────────────────────────────────────────────────
#
# The app instance role (security module) can already read/write the backup
# bucket and publish metrics. These add what the scheduled jobs need on top:
# reading the encryption-key parameter, and — for the recovery-test instance —
# read-only access to the backups it restores.

data "aws_ssm_parameter" "backup_key" {
  count = local.backup_enabled && var.backup_encryption_key_parameter != "" ? 1 : 0

  name            = var.backup_encryption_key_parameter
  with_decryption = false
}

data "aws_iam_policy_document" "backup_key_read" {
  count = length(data.aws_ssm_parameter.backup_key)

  statement {
    sid       = "ReadBackupEncryptionKey"
    actions   = ["ssm:GetParameter"]
    resources = [data.aws_ssm_parameter.backup_key[0].arn]
  }

  statement {
    sid       = "DecryptSecureString"
    actions   = ["kms:Decrypt"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${data.aws_region.current.name}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "backup_key_read" {
  count = length(data.aws_ssm_parameter.backup_key) > 0 && var.instance_role_name != "" ? 1 : 0

  name   = "backup-encryption-key"
  role   = var.instance_role_name
  policy = data.aws_iam_policy_document.backup_key_read[0].json
}

data "aws_iam_policy_document" "recovery_test_read" {
  count = length(local.recovery_jobs) > 0 && var.recovery_test_instance_role_name != "" ? 1 : 0

  statement {
    sid       = "ListBackups"
    actions   = ["s3:ListBucket"]
    resources = ["arn:aws:s3:::${var.backup_bucket_name}"]
  }

  statement {
    sid       = "ReadBackups"
    actions   = ["s3:GetObject"]
    resources = ["arn:aws:s3:::${var.backup_bucket_name}/*"]
  }

  dynamic "statement" {
    for_each = var.backup_kms_key_arn == null ? [] : [var.backup_kms_key_arn]

    content {
      sid       = "DecryptBackups"
      actions   = ["kms:Decrypt"]
      resources = [statement.value]
    }
  }

  dynamic "statement" {
    for_each = data.aws_ssm_parameter.backup_key

    content {
      sid       = "ReadBackupEncryptionKey"
      actions   = ["ssm:GetParameter"]
      resources = [statement.value.arn]
    }
  }
}

resource "aws_iam_role_policy" "recovery_test_read" {
  count = length(data.aws_iam_policy_document.recovery_test_read)

  name   = "${var.name_prefix}-recovery-test-read"
  role   = var.recovery_test_instance_role_name
  policy = data.aws_iam_policy_document.recovery_test_read[0].json
}

# ── Alarms ───────────────────────────────────────────────────────────────────
#
# Missing data is treated as breaching on the freshness alarms: if the
# freshness job itself stops running, that is exactly as bad as a stale
# backup and must page the same way.

resource "aws_cloudwatch_metric_alarm" "daily_backup_stale" {
  count = local.backup_enabled ? 1 : 0

  alarm_name          = "${var.name_prefix}-backup-daily-stale"
  alarm_description   = "No successful daily backup in the last 24 hours (#937). Run `node infra/backup-manager.js backup --type daily` on the instance and check its output."
  namespace           = var.metrics_namespace
  metric_name         = "BackupAgeSeconds"
  dimensions          = { Environment = var.environment, BackupType = "daily" }
  statistic           = "Maximum"
  period              = 900
  evaluation_periods  = 2
  threshold           = 24 * 3600
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [var.alert_topic_arn]
  ok_actions          = [var.alert_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "pitr_backup_stale" {
  count = local.backup_enabled ? 1 : 0

  alarm_name          = "${var.name_prefix}-backup-pitr-stale"
  alarm_description   = "Newest point-in-time snapshot is older than the RPO plus 5 minutes' grace — data loss exposure is growing (#937)."
  namespace           = var.metrics_namespace
  metric_name         = "BackupAgeSeconds"
  dimensions          = { Environment = var.environment, BackupType = "pitr" }
  statistic           = "Maximum"
  period              = 900
  evaluation_periods  = 2
  threshold           = var.pitr_interval_minutes * 60 + 300
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [var.alert_topic_arn]
  ok_actions          = [var.alert_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "recovery_test_failed" {
  count = length(local.recovery_jobs) > 0 ? 1 : 0

  alarm_name          = "${var.name_prefix}-recovery-test-failed"
  alarm_description   = "The weekly recovery test could not restore and verify the newest backup, or missed RPO/RTO. Report: .backup-work/reports on the staging instance (#937)."
  namespace           = var.metrics_namespace
  metric_name         = "RecoveryTestSucceeded"
  dimensions          = { Environment = var.environment }
  statistic           = "Minimum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alert_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "recovery_test_missing" {
  count = length(local.recovery_jobs) > 0 ? 1 : 0

  # Seven daily periods, all of which must be missing or failing: fires when
  # a whole week passes without one successful recovery test.
  alarm_name          = "${var.name_prefix}-recovery-test-missing"
  alarm_description   = "No successful recovery test in 7 days — the weekly schedule is not running (#937)."
  namespace           = var.metrics_namespace
  metric_name         = "RecoveryTestSucceeded"
  dimensions          = { Environment = var.environment }
  statistic           = "Maximum"
  period              = 86400
  evaluation_periods  = 7
  datapoints_to_alarm = 7
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [var.alert_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "recovery_time_over_rto" {
  count = length(local.recovery_jobs) > 0 ? 1 : 0

  alarm_name          = "${var.name_prefix}-recovery-time-over-rto"
  alarm_description   = "Measured restore time exceeded the ${var.rto_target_seconds}s RTO (#937)."
  namespace           = var.metrics_namespace
  metric_name         = "RecoveryTimeSeconds"
  dimensions          = { Environment = var.environment }
  statistic           = "Maximum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = var.rto_target_seconds
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alert_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "recovery_point_gap" {
  count = length(local.recovery_jobs) > 0 ? 1 : 0

  alarm_name          = "${var.name_prefix}-recovery-point-gap"
  alarm_description   = "Largest gap between PITR snapshots in the last 24h exceeded the RPO — at some point this week more than ${var.pitr_interval_minutes} minutes of data was unprotected (#937)."
  namespace           = var.metrics_namespace
  metric_name         = "RecoveryPointGapSeconds"
  dimensions          = { Environment = var.environment }
  statistic           = "Maximum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = var.pitr_interval_minutes * 60 + 300
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alert_topic_arn]
}

output "backup_schedules" {
  description = "Scheduled backup and recovery jobs (EventBridge rule names)."
  value       = { for k, r in aws_cloudwatch_event_rule.backup : k => r.name }
}
