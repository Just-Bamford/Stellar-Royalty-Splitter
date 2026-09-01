variable "name_prefix" {
  description = "Prefix applied to every resource name."
  type        = string
}

variable "vpc_id" {
  description = "VPC to create the security groups in."
  type        = string
}

variable "vpc_cidr" {
  description = "VPC CIDR, used for the in-VPC DNS egress rule."
  type        = string
}

variable "app_port" {
  description = "Port the Express server listens on. Must match PORT in the backend environment."
  type        = number
  default     = 3001
}

variable "allowed_ingress_cidrs" {
  description = "CIDRs permitted to reach the load balancer. Public environments use 0.0.0.0/0; development should be narrowed to known office or VPN ranges."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "enable_http_redirect" {
  description = "Open port 80 so plain HTTP can be redirected to HTTPS. Disable to refuse HTTP outright."
  type        = bool
  default     = true
}

variable "smtp_egress_port" {
  description = "SMTP port for digest and compliance-report mail. Null leaves SMTP egress closed."
  type        = number
  default     = null
}

variable "signing_key_secret_arn" {
  description = "ARN of the Secrets Manager secret holding the server signing key. Null omits the read grant entirely."
  type        = string
  default     = null
}

variable "backup_bucket_arn" {
  description = "ARN of the backup bucket. Null omits the S3 grants."
  type        = string
  default     = null
}

variable "kms_key_arn" {
  description = "ARN of the CMK encrypting backups and secrets. Null omits the KMS grant."
  type        = string
  default     = null
}

variable "log_group_name" {
  description = "CloudWatch log group the instance may write to."
  type        = string
}

variable "metrics_namespace" {
  description = "CloudWatch namespace the instance may publish to. PutMetricData cannot be scoped by resource, so this condition is what bounds it."
  type        = string
  default     = "StellarRoyaltySplitter"
}

variable "enable_ssm_access" {
  description = "Attach AmazonSSMManagedInstanceCore for Session Manager access. This is the only interactive path to a private instance; disabling it leaves no shell access at all."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags applied to every resource in this module."
  type        = map(string)
  default     = {}
}
