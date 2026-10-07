variable "name_prefix" {
  description = "Prefix applied to resources in this region (e.g. srs-us, srs-eu)."
  type        = string
}

variable "aws_region" {
  description = "AWS region for this deployment (e.g. us-east-1, eu-west-1)."
  type        = string
}

variable "environment" {
  description = "Environment name (dev | staging | prod)."
  type        = string
  default     = "prod"
}

variable "is_primary" {
  description = "Whether this region is the primary write region (true) or read-replica/standby (false)."
  type        = bool
  default     = true
}

variable "vpc_cidr" {
  description = "CIDR block for the regional VPC."
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zone_count" {
  description = "Number of AZs to distribute subnets across (at least 2 for ALB)."
  type        = number
  default     = 2
}

variable "instance_type" {
  description = "EC2 instance type for the backend."
  type        = string
  default     = "t3.small"
}

variable "app_port" {
  description = "Port the Express server listens on."
  type        = number
  default     = 3001
}

variable "database_path" {
  description = "Filesystem path to the SQLite database file on the mounted EBS volume."
  type        = string
  default     = "/mnt/data/audit.db"
}

variable "data_volume_size_gb" {
  description = "Size of the regional EBS data volume holding the database."
  type        = number
  default     = 50
}

variable "soroban_rpc_url" {
  description = "Stellar Soroban RPC endpoint configured for this region."
  type        = string
  default     = "https://soroban-testnet.stellar.org"
}

variable "horizon_url" {
  description = "Stellar Horizon endpoint configured for this region."
  type        = string
  default     = "https://horizon-testnet.stellar.org"
}

variable "tags" {
  description = "Resource tags applied to all regional resources."
  type        = map(string)
  default     = {}
}
