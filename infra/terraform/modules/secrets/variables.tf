variable "name_prefix" {
  description = "Prefix applied to every secret name."
  type        = string
}

variable "kms_key_arn" {
  description = "CMK encrypting the secrets. Null uses the AWS-managed key."
  type        = string
  default     = null
}

variable "recovery_window_days" {
  description = "Days a deleted secret can be restored. Set to 0 in disposable environments so a name can be reused immediately after destroy."
  type        = number
  default     = 30

  validation {
    condition     = var.recovery_window_days == 0 || (var.recovery_window_days >= 7 && var.recovery_window_days <= 30)
    error_message = "recovery_window_days must be 0 (immediate deletion) or between 7 and 30."
  }
}

variable "create_signing_key_secret" {
  description = "Create the server signing key secret."
  type        = bool
  default     = true
}

variable "create_backup_key_secret" {
  description = "Create the backup encryption passphrase secret."
  type        = bool
  default     = true
}

variable "create_admin_token_secret" {
  description = "Create the admin rotate-key bearer token secret."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags applied to every secret."
  type        = map(string)
  default     = {}
}
