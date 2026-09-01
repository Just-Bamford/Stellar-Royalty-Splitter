variable "aws_region" {
  description = "AWS region for this environment. us-east-1 matches the default in the backup scripts and backend/.env.example."
  type        = string
  default     = "us-east-1"
}

variable "vpc_cidr" {
  description = "CIDR for the development VPC. Keep the three environments non-overlapping so they can be peered later if needed."
  type        = string
  default     = "10.10.0.0/16"
}

variable "instance_type" {
  description = "EC2 instance type. t3.small is the smallest that comfortably runs Node plus the CloudWatch agent."
  type        = string
  default     = "t3.small"
}

variable "desired_capacity" {
  description = "Running instances. Set to 0 to park the environment overnight without destroying it — the data volume and its contents survive."
  type        = number
  default     = 1

  validation {
    condition     = var.desired_capacity >= 0 && var.desired_capacity <= 1
    error_message = "desired_capacity must be 0 or 1. The application writes to a single SQLite file that cannot be shared between instances."
  }
}

variable "app_port" {
  description = "Port the Express server listens on."
  type        = number
  default     = 3001
}

variable "allowed_ingress_cidrs" {
  description = "CIDRs allowed to reach the load balancer. Narrow this to office or VPN ranges — the default leaves the development API open to the internet."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "certificate_arn" {
  description = "ACM certificate for HTTPS. Null serves plain HTTP, which is acceptable in development only."
  type        = string
  default     = null
}

variable "stellar_network" {
  description = "Target Stellar network. Development must never point at mainnet."
  type        = string
  default     = "testnet"

  validation {
    condition     = var.stellar_network == "testnet"
    error_message = "The development environment must use testnet. Pointing it at mainnet risks real funds from an environment that is routinely destroyed and recreated."
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

variable "log_level" {
  description = "Winston log level."
  type        = string
  default     = "debug"
}

variable "alert_email_addresses" {
  description = "Addresses subscribed to CloudWatch alarms. Each must confirm a subscription email before it receives anything."
  type        = list(string)
  default     = []
}
