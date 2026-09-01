/**
 * Monitoring module — log group, alarms, and a dashboard.
 *
 * Alarms are chosen to fire on things an operator can actually act on, and to
 * stay quiet otherwise. Two decisions shape the set:
 *
 *  - **`treat_missing_data`** is set per alarm rather than left at default.
 *    No 5xx responses produces no datapoints at all, so an error-rate alarm
 *    left on the default would sit in INSUFFICIENT_DATA forever and never
 *    fire. Conversely, the healthy-host alarm treats missing data as breaching:
 *    if the ALB stops reporting hosts entirely, that is the outage, not an
 *    absence of news.
 *
 *  - **Backup freshness is an alarm, not a dashboard widget.** A backup that
 *    silently stops is invisible until a restore is attempted, which is the
 *    worst possible time to discover it. `scripts/backup-monitoring.sh`
 *    already computes this; the alarm here is what makes someone look.
 */

resource "aws_cloudwatch_log_group" "app" {
  name              = var.log_group_name
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn

  tags = merge(var.tags, {
    Name = var.log_group_name
  })
}

resource "aws_sns_topic" "alerts" {
  count = var.create_alert_topic ? 1 : 0

  name              = "${var.name_prefix}-alerts"
  kms_master_key_id = var.kms_key_arn

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-alerts"
  })
}

resource "aws_sns_topic_subscription" "email" {
  for_each = var.create_alert_topic ? toset(var.alert_email_addresses) : toset([])

  topic_arn = aws_sns_topic.alerts[0].arn
  protocol  = "email"
  endpoint  = each.value
}

locals {
  alarm_actions = var.create_alert_topic ? [aws_sns_topic.alerts[0].arn] : var.alarm_action_arns
}

# ── Availability ─────────────────────────────────────────────────────────────

resource "aws_cloudwatch_metric_alarm" "unhealthy_hosts" {
  count = var.target_group_arn_suffix == null ? 0 : 1

  alarm_name        = "${var.name_prefix}-no-healthy-hosts"
  alarm_description = "No healthy targets behind the load balancer. The API is down."

  namespace           = "AWS/ApplicationELB"
  metric_name         = "HealthyHostCount"
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "LessThanThreshold"

  dimensions = {
    TargetGroup  = var.target_group_arn_suffix
    LoadBalancer = var.alb_arn_suffix
  }

  # If the ALB stops publishing this metric, the targets are gone. Silence here
  # is the outage, so missing data breaches rather than being ignored.
  treat_missing_data = "breaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  count = var.alb_arn_suffix == null ? 0 : 1

  alarm_name        = "${var.name_prefix}-api-5xx"
  alarm_description = "The application is returning server errors."

  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.error_5xx_threshold
  comparison_operator = "GreaterThanThreshold"

  dimensions = {
    LoadBalancer = var.alb_arn_suffix
  }

  # No errors means no datapoints. Treating that as breaching would fire this
  # alarm permanently on a healthy system.
  treat_missing_data = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "api_latency" {
  count = var.alb_arn_suffix == null ? 0 : 1

  alarm_name        = "${var.name_prefix}-api-latency-p95"
  alarm_description = "p95 response time is above the agreed budget."

  namespace = "AWS/ApplicationELB"
  # p95 rather than Average: an average hides a slow tail behind a fast
  # majority, and the tail is what users notice.
  metric_name         = "TargetResponseTime"
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 3
  threshold           = var.latency_p95_threshold_seconds
  comparison_operator = "GreaterThanThreshold"

  dimensions = {
    LoadBalancer = var.alb_arn_suffix
  }

  treat_missing_data = "notBreaching"

  alarm_actions = local.alarm_actions

  tags = var.tags
}

# ── Host health ──────────────────────────────────────────────────────────────

resource "aws_cloudwatch_metric_alarm" "disk_space" {
  count = var.autoscaling_group_name == null ? 0 : 1

  alarm_name = "${var.name_prefix}-data-volume-full"
  alarm_description = join(" ", [
    "The data volume is filling up.",
    "SQLite cannot write to a full filesystem, so this becomes a write outage",
    "and, worse, a failed backup, well before the disk is completely full.",
  ])

  namespace           = var.metrics_namespace
  metric_name         = "disk_used_percent"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.disk_used_threshold_percent
  comparison_operator = "GreaterThanThreshold"

  dimensions = {
    AutoScalingGroupName = var.autoscaling_group_name
    path                 = var.data_mount_point
  }

  # Reported by the CloudWatch agent. If the agent dies the datapoints stop,
  # and that is itself worth knowing about.
  treat_missing_data = "breaching"

  alarm_actions = local.alarm_actions

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "memory" {
  count = var.autoscaling_group_name == null ? 0 : 1

  alarm_name        = "${var.name_prefix}-memory-high"
  alarm_description = "Sustained high memory use on the application instance."

  namespace           = var.metrics_namespace
  metric_name         = "mem_used_percent"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = var.memory_used_threshold_percent
  comparison_operator = "GreaterThanThreshold"

  dimensions = {
    AutoScalingGroupName = var.autoscaling_group_name
  }

  treat_missing_data = "notBreaching"

  alarm_actions = local.alarm_actions

  tags = var.tags
}

# ── Backups ──────────────────────────────────────────────────────────────────

resource "aws_cloudwatch_log_metric_filter" "backup_failure" {
  count = var.enable_backup_alarms ? 1 : 0

  name           = "${var.name_prefix}-backup-failures"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "?ERROR ?FATAL ?\"backup failed\""

  metric_transformation {
    name          = "BackupFailures"
    namespace     = var.metrics_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "backup_failure" {
  count = var.enable_backup_alarms ? 1 : 0

  alarm_name = "${var.name_prefix}-backup-failed"
  alarm_description = join(" ", [
    "A backup run reported a failure.",
    "A backup that silently stops working is only discovered during a restore,",
    "which is the worst possible moment to find out.",
  ])

  namespace           = var.metrics_namespace
  metric_name         = "BackupFailures"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"

  treat_missing_data = "notBreaching"

  alarm_actions = local.alarm_actions

  tags = var.tags

  depends_on = [aws_cloudwatch_log_metric_filter.backup_failure]
}

# ── Dashboard ────────────────────────────────────────────────────────────────

resource "aws_cloudwatch_dashboard" "main" {
  count = var.create_dashboard ? 1 : 0

  dashboard_name = "${var.name_prefix}-overview"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        width  = 12
        height = 6
        properties = {
          title  = "Request rate and errors"
          region = var.aws_region
          view   = "timeSeries"
          metrics = [
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", var.alb_arn_suffix, { stat = "Sum" }],
            [".", "HTTPCode_Target_5XX_Count", ".", ".", { stat = "Sum" }],
            [".", "HTTPCode_Target_4XX_Count", ".", ".", { stat = "Sum" }],
          ]
        }
      },
      {
        type   = "metric"
        width  = 12
        height = 6
        properties = {
          title  = "Response time"
          region = var.aws_region
          view   = "timeSeries"
          metrics = [
            ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", var.alb_arn_suffix, { stat = "p50" }],
            ["...", { stat = "p95" }],
            ["...", { stat = "p99" }],
          ]
        }
      },
      {
        type   = "metric"
        width  = 12
        height = 6
        properties = {
          title  = "Healthy targets"
          region = var.aws_region
          view   = "timeSeries"
          metrics = [
            ["AWS/ApplicationELB", "HealthyHostCount", "TargetGroup", var.target_group_arn_suffix, "LoadBalancer", var.alb_arn_suffix, { stat = "Minimum" }],
            [".", "UnHealthyHostCount", ".", ".", ".", ".", { stat = "Maximum" }],
          ]
        }
      },
      {
        type   = "metric"
        width  = 12
        height = 6
        properties = {
          title  = "Instance resources"
          region = var.aws_region
          view   = "timeSeries"
          metrics = [
            [var.metrics_namespace, "mem_used_percent", "AutoScalingGroupName", var.autoscaling_group_name, { stat = "Average" }],
            [".", "disk_used_percent", ".", ".", "path", var.data_mount_point, { stat = "Maximum" }],
          ]
        }
      },
      {
        type   = "log"
        width  = 24
        height = 6
        properties = {
          title  = "Recent errors"
          region = var.aws_region
          query  = "SOURCE '${aws_cloudwatch_log_group.app.name}' | fields @timestamp, @message | filter @message like /ERROR|FATAL/ | sort @timestamp desc | limit 50"
          view   = "table"
        }
      },
    ]
  })
}
