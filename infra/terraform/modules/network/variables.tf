variable "name_prefix" {
  description = "Prefix applied to every resource name, e.g. \"srs-dev\"."
  type        = string
}

variable "aws_region" {
  description = "AWS region. Used to build the S3 VPC endpoint service name."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC. Must be a /16 so the /24 subnet split has room."
  type        = string
  default     = "10.0.0.0/16"

  validation {
    condition     = can(cidrnetmask(var.vpc_cidr)) && tonumber(split("/", var.vpc_cidr)[1]) <= 16
    error_message = "vpc_cidr must be a valid CIDR block of /16 or larger."
  }
}

variable "availability_zone_count" {
  description = "Number of AZs to span. Two is the ALB minimum; three is worth the cost only where availability is a requirement."
  type        = number
  default     = 2

  validation {
    condition     = var.availability_zone_count >= 2 && var.availability_zone_count <= 4
    error_message = "availability_zone_count must be between 2 and 4 (an ALB requires at least two subnets)."
  }
}

variable "enable_nat_gateway" {
  description = "Provision NAT so private instances can reach Horizon and Soroban RPC. Disabling leaves the app with no outbound internet."
  type        = bool
  default     = true
}

variable "one_nat_gateway_per_az" {
  description = "One NAT per AZ instead of a single shared one. Removes a single point of failure at roughly triple the cost — the largest cost lever here."
  type        = bool
  default     = false
}

variable "enable_s3_endpoint" {
  description = "Gateway endpoint for S3, keeping backup traffic off the NAT gateway."
  type        = bool
  default     = true
}

variable "enable_flow_logs" {
  description = "Log rejected VPC traffic to CloudWatch."
  type        = bool
  default     = false
}

variable "flow_log_retention_days" {
  description = "Retention for the flow-log group."
  type        = number
  default     = 30
}

variable "tags" {
  description = "Tags applied to every resource in this module."
  type        = map(string)
  default     = {}
}
