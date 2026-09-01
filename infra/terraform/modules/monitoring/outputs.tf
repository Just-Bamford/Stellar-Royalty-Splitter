output "log_group_name" {
  description = "CloudWatch log group name."
  value       = aws_cloudwatch_log_group.app.name
}

output "log_group_arn" {
  description = "CloudWatch log group ARN."
  value       = aws_cloudwatch_log_group.app.arn
}

output "alert_topic_arn" {
  description = "SNS topic carrying alarm notifications. Subscribe PagerDuty or Slack here."
  value       = var.create_alert_topic ? aws_sns_topic.alerts[0].arn : null
}

output "dashboard_name" {
  description = "CloudWatch dashboard name."
  value       = var.create_dashboard ? aws_cloudwatch_dashboard.main[0].dashboard_name : null
}

output "alarm_names" {
  description = "Every alarm created here, for the disaster-recovery tooling to assert on after a restore."
  value = compact([
    var.target_group_arn_suffix == null ? "" : aws_cloudwatch_metric_alarm.unhealthy_hosts[0].alarm_name,
    var.alb_arn_suffix == null ? "" : aws_cloudwatch_metric_alarm.api_5xx[0].alarm_name,
    var.alb_arn_suffix == null ? "" : aws_cloudwatch_metric_alarm.api_latency[0].alarm_name,
    var.autoscaling_group_name == null ? "" : aws_cloudwatch_metric_alarm.disk_space[0].alarm_name,
    var.autoscaling_group_name == null ? "" : aws_cloudwatch_metric_alarm.memory[0].alarm_name,
    var.enable_backup_alarms ? aws_cloudwatch_metric_alarm.backup_failure[0].alarm_name : "",
  ])
}
