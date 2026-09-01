variable "name_prefix" {
  description = "Prefix applied to every resource name."
  type        = string
}

variable "backup_bucket_name" {
  description = "Name of the backup bucket. Must match BACKUP_S3_BUCKET in the backup scripts' environment."
  type        = string
}

variable "backup_bucket_force_destroy" {
  description = "Allow `terraform destroy` to delete a non-empty backup bucket. True only in disposable environments; production must keep this false."
  type        = bool
  default     = false
}

variable "create_kms_key" {
  description = "Create a customer-managed key for this environment."
  type        = bool
  default     = true
}

variable "kms_key_arn" {
  description = "Existing CMK to use when create_kms_key is false. Null falls back to SSE-S3."
  type        = string
  default     = null
}

variable "kms_deletion_window_days" {
  description = "Waiting period before a scheduled key deletion completes."
  type        = number
  default     = 30

  validation {
    condition     = var.kms_deletion_window_days >= 7 && var.kms_deletion_window_days <= 30
    error_message = "kms_deletion_window_days must be between 7 and 30."
  }
}

variable "daily_retention_days" {
  description = "Retention for daily backups. Mirrors docs/backup-strategy.md."
  type        = number
  default     = 7
}

variable "weekly_retention_days" {
  description = "Retention for weekly backups."
  type        = number
  default     = 30
}

variable "monthly_retention_days" {
  description = "Retention for monthly backups."
  type        = number
  default     = 365
}

variable "noncurrent_version_retention_days" {
  description = "How long superseded object versions are kept. This is the window for recovering from a corrupted database being backed up over a good copy."
  type        = number
  default     = 30
}

variable "create_data_volume" {
  description = "Create the EBS volume holding the SQLite audit database."
  type        = bool
  default     = true
}

variable "data_volume_availability_zone" {
  description = "AZ for the data volume. Must match the instance's AZ — EBS cannot cross AZs."
  type        = string
  default     = null
}

variable "data_volume_size_gb" {
  description = "Size of the data volume."
  type        = number
  default     = 20
}

variable "enable_volume_snapshots" {
  description = "Take daily EBS snapshots via Data Lifecycle Manager, independently of the S3 backup script."
  type        = bool
  default     = true
}

variable "snapshot_retention_count" {
  description = "Number of daily snapshots to retain."
  type        = number
  default     = 7
}

variable "tags" {
  description = "Tags applied to every resource in this module."
  type        = map(string)
  default     = {}
}
