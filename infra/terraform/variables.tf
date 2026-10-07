variable "name_prefix" {
  description = "Prefix applied to all multi-region resources."
  type        = string
  default     = "srs-mr"
}

variable "environment" {
  description = "Environment name (dev | staging | prod)."
  type        = string
  default     = "prod"
}

variable "us_region" {
  description = "Primary AWS region (US)."
  type        = string
  default     = "us-east-1"
}

variable "eu_region" {
  description = "Secondary / Replica AWS region (EU)."
  type        = string
  default     = "eu-west-1"
}

variable "us_vpc_cidr" {
  description = "CIDR block for the US VPC."
  type        = string
  default     = "10.0.0.0/16"
}

variable "eu_vpc_cidr" {
  description = "CIDR block for the EU VPC."
  type        = string
  default     = "10.1.0.0/16"
}

variable "app_port" {
  description = "Application port the backend listens on."
  type        = number
  default     = 3001
}

variable "us_soroban_rpc_url" {
  description = "Soroban RPC endpoint for the US region."
  type        = string
  default     = "https://soroban-testnet.stellar.org"
}

variable "us_horizon_url" {
  description = "Horizon endpoint for the US region."
  type        = string
  default     = "https://horizon-testnet.stellar.org"
}

variable "eu_soroban_rpc_url" {
  description = "Soroban RPC endpoint for the EU region."
  type        = string
  default     = "https://soroban-testnet.stellar.org"
}

variable "eu_horizon_url" {
  description = "Horizon endpoint for the EU region."
  type        = string
  default     = "https://horizon-testnet.stellar.org"
}

variable "domain_name" {
  description = "Domain name for Route53 global failover / routing (optional)."
  type        = string
  default     = null
}

variable "route53_zone_id" {
  description = "Route53 Hosted Zone ID for DNS failover and geolocation records (optional)."
  type        = string
  default     = null
}

variable "enable_dns_failover" {
  description = "Whether to configure Route53 health checks and active-passive failover."
  type        = bool
  default     = true
}

# CDN Configuration (#944)
variable "cdn_price_class" {
  description = "CloudFront price class for edge location coverage (PriceClass_100 | PriceClass_200 | PriceClass_All)"
  type        = string
  default     = "PriceClass_All"
}

variable "cdn_certificate_arn" {
  description = "ACM certificate ARN for custom domain on CDN (optional - uses CloudFront default certificate if null)"
  type        = string
  default     = null
}

variable "cdn_origin_verification_token" {
  description = "Custom header token for origin verification (prevent direct S3 access)"
  type        = string
  default     = "stellar-royalty-splitter-origin"
  sensitive   = true
}

variable "cdn_enabled" {
  description = "Whether to deploy the CDN infrastructure"
  type        = bool
  default     = true
}

variable "project_name" {
  description = "Project name for resource naming"
  type        = string
  default     = "stellar-royalty-splitter"
}

variable "common_tags" {
  description = "Common tags to apply to all resources"
  type        = map(string)
  default = {
    Project     = "stellar-royalty-splitter"
    ManagedBy   = "Terraform"
    Environment = "production"
  }
}
