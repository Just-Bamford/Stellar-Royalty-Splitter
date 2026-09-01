variable "name_prefix" {
  description = "Prefix applied to every resource name."
  type        = string
}

variable "aws_region" {
  description = "AWS region, used by the dashboard widgets."
  type        = string
}

variable "log_group_name" {
  description = "CloudWatch log group for application and bootstrap logs."
  type        = string
}

variable "log_retention_days" {
  description = "Log retention. The audit trail lives in the database, so this only needs to cover operational debugging."
  type        = number
  default     = 30
}

variable "kms_key_arn" {
  description = "CMK for log group and SNS encryption. Null uses AWS-managed keys."
  type        = string
  default     = null
}

variable "metrics_namespace" {
  description = "CloudWatch namespace for instance and application metrics."
  type        = string
  default     = "StellarRoyaltySplitter"
}

variable "create_alert_topic" {
  description = "Create an SNS topic for alarm notifications."
  type        = bool
  default     = true
}

variable "alert_email_addresses" {
  description = "Addresses subscribed to the alert topic. Each requires confirming a subscription email before it receives anything."
  type        = list(string)
  default     = []
}

variable "alarm_action_arns" {
  description = "Existing alarm action targets, used when create_alert_topic is false."
  type        = list(string)
  default     = []
}

variable "alb_arn_suffix" {
  description = "Load balancer ARN suffix for metric dimensions. Null skips the ALB alarms."
  type        = string
  default     = null
}

variable "target_group_arn_suffix" {
  description = "Target group ARN suffix for metric dimensions. Null skips the healthy-host alarm."
  type        = string
  default     = null
}

variable "autoscaling_group_name" {
  description = "ASG name for instance metric dimensions. Null skips the host alarms."
  type        = string
  default     = null
}

variable "data_mount_point" {
  description = "Mount point of the data volume, used as the disk alarm dimension."
  type        = string
  default     = "/var/data"
}

variable "error_5xx_threshold" {
  description = "5xx responses in a 5-minute window before alarming."
  type        = number
  default     = 10
}

variable "latency_p95_threshold_seconds" {
  description = "p95 response time budget in seconds."
  type        = number
  default     = 2
}

variable "disk_used_threshold_percent" {
  description = "Data volume utilisation that triggers an alarm. Deliberately well below full — SQLite fails to write, and backups fail, before a disk is completely full."
  type        = number
  default     = 80
}

variable "memory_used_threshold_percent" {
  description = "Memory utilisation that triggers an alarm."
  type        = number
  default     = 85
}

variable "enable_backup_alarms" {
  description = "Alarm when a backup run logs a failure."
  type        = bool
  default     = true
}

variable "create_dashboard" {
  description = "Create the CloudWatch overview dashboard."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags applied to every resource in this module."
  type        = map(string)
  default     = {}
}
