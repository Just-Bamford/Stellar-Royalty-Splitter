/**
 * Production environment (#870).
 *
 * Structurally identical to development — the same six modules, wired the same
 * way — so a change validated in development behaves the same here. What
 * differs is durability, redundancy, and how hard it is to destroy something
 * by accident. Every difference is annotated at the point it is made.
 *
 * Hard requirements enforced by variable validation rather than convention:
 *   - a TLS certificate must be supplied;
 *   - request signature verification must be on;
 *   - the ingress range must be stated explicitly.
 *
 * Deletion protection is on for the load balancer, `prevent_destroy` guards
 * the data volume, and the backup bucket refuses `force_destroy`. Tearing this
 * environment down is deliberately awkward.
 */

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {}
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.common_tags
  }
}

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = local.common_tags
  }
}

data "aws_caller_identity" "current" {}

locals {
  environment = "prod"
  name_prefix = "srs-prod"

  common_tags = {
    Project     = "stellar-royalty-splitter"
    Environment = local.environment
    ManagedBy   = "terraform"
    Repository  = "Just-Bamford/Stellar-Royalty-Splitter"
    Criticality = "high"
  }

  log_group_name = "/aws/ec2/${local.name_prefix}"

  account_id           = data.aws_caller_identity.current.account_id
  backup_bucket_name   = "${local.name_prefix}-backups-${local.account_id}"
  frontend_bucket_name = "${local.name_prefix}-frontend-${local.account_id}"

  ssm_parameter_path = "/${local.name_prefix}/config"
}

module "network" {
  source = "../../modules/network"

  name_prefix = local.name_prefix
  aws_region  = var.aws_region
  vpc_cidr    = var.vpc_cidr

  # Three AZs so losing one leaves two.
  availability_zone_count = 3

  # One NAT per AZ. Roughly triples the NAT bill and removes a single point of
  # failure on the path to Horizon and Soroban RPC — without which a NAT
  # failure would stop every transaction the service can build.
  enable_nat_gateway     = true
  one_nat_gateway_per_az = true

  enable_s3_endpoint = true

  # On here: the rejected-traffic record is what an incident investigation
  # starts from.
  enable_flow_logs        = true
  flow_log_retention_days = 90

  tags = local.common_tags
}

module "storage" {
  source = "../../modules/storage"

  name_prefix        = local.name_prefix
  backup_bucket_name = local.backup_bucket_name

  # Refuses to delete a non-empty backup bucket. The audit-database backups
  # live here; `terraform destroy` must not be able to remove them.
  backup_bucket_force_destroy = false

  create_kms_key = true
  # The maximum. This window is the only thing standing between a mistaken key
  # deletion and every backup becoming permanently unreadable.
  kms_deletion_window_days = 30

  # Mirrors docs/backup-strategy.md exactly.
  daily_retention_days              = 7
  weekly_retention_days             = 30
  monthly_retention_days            = 365
  noncurrent_version_retention_days = 90

  create_data_volume            = true
  data_volume_availability_zone = module.network.availability_zones[0]
  data_volume_size_gb           = var.data_volume_size_gb

  # A second, independent recovery path. The S3 backups are logical and
  # encrypted with a passphrase; a snapshot restores the whole filesystem and
  # does not depend on that passphrase still being available.
  enable_volume_snapshots  = true
  snapshot_retention_count = 14

  tags = local.common_tags
}

module "secrets" {
  source = "../../modules/secrets"

  name_prefix = local.name_prefix
  kms_key_arn = module.storage.kms_key_arn

  # The full window. A secret deleted here is recoverable for 30 days; in
  # development this is 0 so environments can be recycled freely.
  recovery_window_days = 30

  tags = local.common_tags
}

module "monitoring" {
  source = "../../modules/monitoring"

  name_prefix    = local.name_prefix
  aws_region     = var.aws_region
  log_group_name = local.log_group_name

  log_retention_days = 90
  kms_key_arn        = module.storage.kms_key_arn

  create_alert_topic    = true
  alert_email_addresses = var.alert_email_addresses

  alb_arn_suffix          = module.compute.alb_arn_suffix
  target_group_arn_suffix = module.compute.target_group_arn_suffix
  autoscaling_group_name  = module.compute.autoscaling_group_name

  # Tighter than development. These are the numbers that should wake someone.
  error_5xx_threshold           = 5
  latency_p95_threshold_seconds = 2
  disk_used_threshold_percent   = 75

  enable_backup_alarms = true
  create_dashboard     = true

  tags = local.common_tags
}

module "security" {
  source = "../../modules/security"

  name_prefix = local.name_prefix
  vpc_id      = module.network.vpc_id
  vpc_cidr    = module.network.vpc_cidr
  app_port    = var.app_port

  allowed_ingress_cidrs = var.allowed_ingress_cidrs

  # No plain HTTP at all. The redirect is a convenience; production refuses
  # the connection instead.
  enable_http_redirect = false

  signing_key_secret_arn = module.secrets.signing_key_secret_arn
  backup_bucket_arn      = module.storage.backup_bucket_arn
  kms_key_arn            = module.storage.kms_key_arn
  log_group_name         = local.log_group_name

  # Session Manager is the only interactive path in. Turning it off would mean
  # no way to reach the instance during an incident.
  enable_ssm_access = true

  tags = local.common_tags
}

module "compute" {
  source = "../../modules/compute"

  name_prefix = local.name_prefix
  environment = local.environment
  aws_region  = var.aws_region

  vpc_id             = module.network.vpc_id
  public_subnet_ids  = module.network.public_subnet_ids
  private_subnet_ids = module.network.private_subnet_ids

  alb_security_group_id = module.security.alb_security_group_id
  app_security_group_id = module.security.app_security_group_id
  instance_profile_name = module.security.instance_profile_name

  instance_type = var.instance_type
  app_port      = var.app_port

  # Still one instance. This is the architecture's ceiling, not a cost choice:
  # the SQLite database on a single EBS volume cannot be shared. Removing this
  # limit requires migrating to a networked database first.
  min_size         = 1
  max_size         = 1
  desired_capacity = 1

  data_volume_id                = module.storage.data_volume_id
  data_volume_subnet_id         = module.network.private_subnet_ids[0]
  data_volume_availability_zone = module.network.availability_zones[0]

  kms_key_arn = module.storage.kms_key_arn

  # Required — see the variable's validation block.
  certificate_arn = var.certificate_arn

  # Stops `terraform destroy` removing the public entry point.
  enable_deletion_protection = true

  enable_detailed_monitoring = true
  access_logs_bucket         = var.alb_access_logs_bucket

  log_group_name     = local.log_group_name
  ssm_parameter_path = local.ssm_parameter_path

  tags = local.common_tags
}

module "frontend" {
  source = "../../modules/frontend"

  name_prefix = local.name_prefix
  bucket_name = local.frontend_bucket_name

  force_destroy = false
  # Rolling back a bad frontend deploy becomes a version restore rather than a
  # rebuild from a git tag.
  enable_versioning = true

  # Global edge coverage.
  price_class = "PriceClass_All"

  domain_aliases      = var.frontend_domain_aliases
  acm_certificate_arn = var.frontend_certificate_arn

  response_headers_policy_id = var.response_headers_policy_id
  web_acl_arn                = var.web_acl_arn

  tags = local.common_tags
}

resource "aws_ssm_parameter" "config" {
  for_each = {
    STELLAR_NETWORK = var.stellar_network
    SOROBAN_RPC_URL = var.soroban_rpc_url
    HORIZON_URL     = var.horizon_url
    FRONTEND_ORIGIN = module.frontend.frontend_url
    LOG_LEVEL       = var.log_level

    BACKUP_S3_BUCKET = module.storage.backup_bucket_name
    BACKUP_S3_REGION = var.aws_region

    AWS_SECRET_NAME = module.secrets.signing_key_secret_name

    # Mandatory on mainnet. backend/.env.example states this outright; the
    # variable validation below refuses to let it be turned off here.
    SIGNATURE_VERIFICATION_ENABLED = var.signature_verification_enabled ? "true" : "false"
  }

  name  = "${local.ssm_parameter_path}/${each.key}"
  type  = "String"
  value = each.value

  tags = local.common_tags
}
