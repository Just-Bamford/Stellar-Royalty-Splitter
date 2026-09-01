variable "aws_region" {
  description = "AWS region for this environment."
  type        = string
  default     = "us-east-1"
}

variable "vpc_cidr" {
  description = "CIDR for the staging VPC. Non-overlapping with dev and prod."
  type        = string
  default     = "10.20.0.0/16"
}

variable "instance_type" {
  description = "EC2 instance type."
  type        = string
  default     = "t3.small"
}

variable "app_port" {
  description = "Port the Express server listens on."
  type        = number
  default     = 3001
}

variable "data_volume_size_gb" {
  description = "Size of the volume holding the SQLite database. Smaller than production; the disk alarm still fires at 75% used."
  type        = number
  default     = 20
}

variable "allowed_ingress_cidrs" {
  description = "CIDRs allowed to reach the load balancer. Stated explicitly rather than defaulted — see the validation."
  type        = list(string)

  validation {
    condition     = length(var.allowed_ingress_cidrs) > 0
    error_message = "allowed_ingress_cidrs must be set explicitly in staging. Use [\"0.0.0.0/0\"] if the API is genuinely public; the point is that it is a stated decision rather than an inherited default."
  }
}

variable "certificate_arn" {
  description = "ACM certificate for the API load balancer. Required."
  type        = string

  validation {
    condition     = can(regex("^arn:aws:acm:", var.certificate_arn))
    error_message = "certificate_arn must be a valid ACM certificate ARN. Staging mirrors production and must not serve the API over plain HTTP."
  }
}

variable "frontend_domain_aliases" {
  description = "Custom domains served by the CloudFront distribution."
  type        = list(string)
  default     = []
}

variable "frontend_certificate_arn" {
  description = "ACM certificate for the frontend domains. Must be issued in us-east-1 — CloudFront reads certificates only from that region."
  type        = string
  default     = null
}

variable "response_headers_policy_id" {
  description = "CloudFront response headers policy supplying HSTS, CSP, and related headers."
  type        = string
  default     = null
}

variable "web_acl_arn" {
  description = "WAFv2 web ACL for the distribution. Must be scoped CLOUDFRONT and created in us-east-1."
  type        = string
  default     = null
}

variable "alb_access_logs_bucket" {
  description = "Bucket for ALB access logs. Null disables them."
  type        = string
  default     = null
}

variable "stellar_network" {
  description = "Target Stellar network."
  type        = string
  default     = "testnet"

  validation {
    condition     = var.stellar_network == "testnet"
    error_message = "The staging environment must use testnet. Rehearsing against mainnet would move real funds."
  }
}

variable "soroban_rpc_url" {
  description = "Soroban RPC endpoint."
  type        = string
  default     = "https://soroban-testnet.stellar.org"
}

variable "horizon_url" {
  description = "Horizon endpoint."
  type        = string
  default     = "https://horizon-testnet.stellar.org"
}

variable "signature_verification_enabled" {
  description = "Ed25519 request signature verification. Mandatory on mainnet."
  type        = bool
  default     = true

  validation {
    condition     = var.signature_verification_enabled
    error_message = "signature_verification_enabled must be true in staging. backend/.env.example states it is mandatory on mainnet deployments; disabling it would accept unsigned requests on a service that moves funds."
  }
}

variable "log_level" {
  description = "Winston log level."
  type        = string
  default     = "info"
}

variable "alert_email_addresses" {
  description = "Addresses subscribed to CloudWatch alarms. At least one is required — alarms nobody receives are not monitoring."
  type        = list(string)

  validation {
    condition     = length(var.alert_email_addresses) > 0
    error_message = "At least one alert email address is required in staging."
  }
}
