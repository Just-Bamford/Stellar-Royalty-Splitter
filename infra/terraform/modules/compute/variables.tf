variable "name_prefix" {
  description = "Prefix applied to every resource name. Kept short — ALB and target-group name prefixes are capped at 6 characters."
  type        = string
}

variable "environment" {
  description = "Environment name (dev | staging | prod)."
  type        = string
}

variable "aws_region" {
  description = "AWS region, passed through to the instance bootstrap."
  type        = string
}

variable "vpc_id" {
  description = "VPC to create the target group in."
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnets for the load balancer. At least two, in different AZs."
  type        = list(string)

  validation {
    condition     = length(var.public_subnet_ids) >= 2
    error_message = "An application load balancer requires at least two subnets in different availability zones."
  }
}

variable "private_subnet_ids" {
  description = "Private subnets the instance may launch into."
  type        = list(string)
}

variable "alb_security_group_id" {
  description = "Security group for the load balancer."
  type        = string
}

variable "app_security_group_id" {
  description = "Security group for the application instances."
  type        = string
}

variable "instance_profile_name" {
  description = "Instance profile granting the role from the security module."
  type        = string
}

variable "ami_id" {
  description = "AMI to launch. Null resolves the latest Amazon Linux 2023."
  type        = string
  default     = null
}

variable "instance_type" {
  description = "EC2 instance type."
  type        = string
  default     = "t3.small"
}

variable "root_volume_size_gb" {
  description = "Root volume size. Holds the OS, Node, and application code — not the database."
  type        = number
  default     = 20
}

variable "app_port" {
  description = "Port the Express server listens on. Must match PORT in the application environment."
  type        = number
  default     = 3001
}

variable "min_size" {
  description = "Minimum instances. One is also the maximum — see max_size."
  type        = number
  default     = 1
}

variable "max_size" {
  description = "Maximum instances. Capped at 1: the application writes to a single SQLite file on one EBS volume, and a second writer would corrupt it."
  type        = number
  default     = 1

  validation {
    condition     = var.max_size == 1
    error_message = "max_size must be 1. The current architecture stores state in SQLite on a single EBS volume, which cannot be shared between instances. Scaling out requires migrating to a networked database first."
  }
}

variable "desired_capacity" {
  description = "Desired instance count."
  type        = number
  default     = 1
}

variable "data_volume_id" {
  description = "EBS volume holding the SQLite database, attached during bootstrap. Null skips attachment."
  type        = string
  default     = null
}

variable "data_volume_subnet_id" {
  description = "Subnet the instance must launch into so it can attach the data volume. Null allows any private subnet — only safe when there is no data volume."
  type        = string
  default     = null
}

variable "data_volume_availability_zone" {
  description = "AZ of the data volume. Informational; placement is driven by data_volume_subnet_id."
  type        = string
  default     = null
}

variable "data_mount_point" {
  description = "Where the data volume is mounted."
  type        = string
  default     = "/var/data"
}

variable "database_path" {
  description = "Absolute path to the SQLite file. Must sit under data_mount_point to survive instance replacement."
  type        = string
  default     = "/var/data/audit.db"
}

variable "kms_key_arn" {
  description = "CMK for root volume encryption. Null uses the AWS-managed EBS key."
  type        = string
  default     = null
}

variable "certificate_arn" {
  description = "ACM certificate for the HTTPS listener. Null serves plain HTTP on port 80 — acceptable in development, never in production."
  type        = string
  default     = null
}

variable "ssl_policy" {
  description = "ALB TLS policy. The default forbids TLS below 1.2."
  type        = string
  default     = "ELBSecurityPolicy-TLS13-1-2-2021-06"
}

variable "enable_deletion_protection" {
  description = "Prevent the load balancer being deleted by a terraform destroy."
  type        = bool
  default     = false
}

variable "idle_timeout_seconds" {
  description = "ALB idle timeout. Keep above the backend REQUEST_TIMEOUT_MS so the application timeout fires first and can log it."
  type        = number
  default     = 60
}

variable "health_check_path" {
  description = "Health check path. Defaults to the liveness probe, which answers from the process alone. The /api/v1/health endpoint probes Horizon and Soroban RPC, so using it would let an upstream Stellar outage trigger instance replacement."
  type        = string
  default     = "/api/v1/liveness"
}

variable "health_check_interval_seconds" {
  description = "Seconds between health checks."
  type        = number
  default     = 30
}

variable "health_check_timeout_seconds" {
  description = "Health check timeout."
  type        = number
  default     = 5
}

variable "health_check_unhealthy_threshold" {
  description = "Consecutive failures before a target is taken out of service."
  type        = number
  default     = 3
}

variable "health_check_grace_period_seconds" {
  description = "Seconds before the ASG starts health-checking a new instance. Must cover volume attach, mount, package install, and application start."
  type        = number
  default     = 300
}

variable "deregistration_delay_seconds" {
  description = "Drain time before a target is removed. Long enough for an in-flight distribute polling Horizon to finish."
  type        = number
  default     = 60
}

variable "enable_instance_refresh" {
  description = "Roll instances automatically when the launch template changes. At one instance this is a brief interruption."
  type        = bool
  default     = true
}

variable "enable_detailed_monitoring" {
  description = "One-minute CloudWatch metrics instead of five."
  type        = bool
  default     = false
}

variable "access_logs_bucket" {
  description = "Bucket for ALB access logs. Null disables them."
  type        = string
  default     = null
}

variable "log_group_name" {
  description = "CloudWatch log group the instance writes to."
  type        = string
}

variable "metrics_namespace" {
  description = "CloudWatch namespace for instance metrics."
  type        = string
  default     = "StellarRoyaltySplitter"
}

variable "ssm_parameter_path" {
  description = "SSM Parameter Store path holding non-secret application configuration, read into the environment file at boot."
  type        = string
}

variable "tags" {
  description = "Tags applied to every resource in this module."
  type        = map(string)
  default     = {}
}
