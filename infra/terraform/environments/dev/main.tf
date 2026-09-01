/**
 * Development environment (#870).
 *
 * The cheapest configuration that still exercises every module, so a change
 * can be validated here before it reaches staging. Where development differs
 * from production the reason is cost or disposability, and each difference is
 * called out at the point it is made — see `environments/README.md` for the
 * full comparison.
 *
 * This environment is meant to be destroyed and recreated freely. Nothing here
 * holds data that cannot be regenerated.
 */

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Remote state with DynamoDB locking. Values are supplied by
  # `backend.hcl` rather than hard-coded, because the bucket name embeds an
  # account id that must not be committed:
  #
  #   terraform init -backend-config=backend.hcl
  #
  # See infra/terraform/README.md for bootstrapping the state bucket itself.
  backend "s3" {}
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.common_tags
  }
}

# CloudFront reads ACM certificates only from us-east-1, regardless of where
# the rest of the stack lives.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = local.common_tags
  }
}

data "aws_caller_identity" "current" {}

locals {
  environment = "dev"
  name_prefix = "srs-dev"

  common_tags = {
    Project     = "stellar-royalty-splitter"
    Environment = local.environment
    ManagedBy   = "terraform"
    Repository  = "Just-Bamford/Stellar-Royalty-Splitter"
  }

  log_group_name = "/aws/ec2/${local.name_prefix}"

  # Bucket names are globally unique across all AWS accounts, so the account id
  # is appended rather than hoping "srs-dev-backups" is free.
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

  availability_zone_count = 2

  # A single NAT rather than one per AZ. This is the largest cost line in the
  # environment and development does not need the redundancy.
  enable_nat_gateway     = true
  one_nat_gateway_per_az = false

  enable_s3_endpoint = true

  # Off in development: flow logs are for investigating production incidents
  # and cost more than they are worth here.
  enable_flow_logs = false

  tags = local.common_tags
}

module "storage" {
  source = "../../modules/storage"

  name_prefix        = local.name_prefix
  backup_bucket_name = local.backup_bucket_name

  # Development must be destroyable in one command; production sets this false
  # so the audit backups cannot be removed by accident.
  backup_bucket_force_destroy = true

  create_kms_key = true
  # The minimum. In production a longer window is the safety net against a
  # mistaken key deletion taking every backup with it.
  kms_deletion_window_days = 7

  # Shorter than production's, to keep storage costs negligible.
  daily_retention_days              = 3
  weekly_retention_days             = 7
  monthly_retention_days            = 30
  noncurrent_version_retention_days = 7

  create_data_volume            = true
  data_volume_availability_zone = module.network.availability_zones[0]
  data_volume_size_gb           = 10

  # Off in development — the S3 backup path is the one being exercised, and
  # snapshots would duplicate it at extra cost.
  enable_volume_snapshots = false

  tags = local.common_tags
}

module "secrets" {
  source = "../../modules/secrets"

  name_prefix = local.name_prefix
  kms_key_arn = module.storage.kms_key_arn

  # Zero so a destroyed environment can be recreated immediately. With the
  # default 30-day window the secret names stay reserved and the next apply
  # fails on a name collision.
  recovery_window_days = 0

  tags = local.common_tags
}

module "monitoring" {
  source = "../../modules/monitoring"

  name_prefix    = local.name_prefix
  aws_region     = var.aws_region
  log_group_name = local.log_group_name

  # Long enough to debug a failed deploy, short enough to be free.
  log_retention_days = 7

  # Left unencrypted: a CMK on the log group blocks the CloudWatch console
  # from rendering logs for anyone without kms:Decrypt, which is friction
  # development does not need.
  kms_key_arn = null

  create_alert_topic    = true
  alert_email_addresses = var.alert_email_addresses

  alb_arn_suffix          = module.compute.alb_arn_suffix
  target_group_arn_suffix = module.compute.target_group_arn_suffix
  autoscaling_group_name  = module.compute.autoscaling_group_name

  # Looser than production so ordinary development activity does not page.
  error_5xx_threshold           = 50
  latency_p95_threshold_seconds = 5

  create_dashboard = true

  tags = local.common_tags
}

module "security" {
  source = "../../modules/security"

  name_prefix = local.name_prefix
  vpc_id      = module.network.vpc_id
  vpc_cidr    = module.network.vpc_cidr
  app_port    = var.app_port

  # Should be narrowed to office or VPN ranges. Left open by default only
  # because a development environment nobody can reach is not useful; set
  # `allowed_ingress_cidrs` in terraform.tfvars to restrict it.
  allowed_ingress_cidrs = var.allowed_ingress_cidrs

  signing_key_secret_arn = module.secrets.signing_key_secret_arn
  backup_bucket_arn      = module.storage.backup_bucket_arn
  kms_key_arn            = module.storage.kms_key_arn
  log_group_name         = local.log_group_name

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

  # One instance: SQLite is single-writer. See the compute module header.
  min_size         = 1
  max_size         = 1
  desired_capacity = var.desired_capacity

  data_volume_id                = module.storage.data_volume_id
  data_volume_subnet_id         = module.network.private_subnet_ids[0]
  data_volume_availability_zone = module.network.availability_zones[0]

  kms_key_arn = module.storage.kms_key_arn

  # No certificate in development, so the ALB serves plain HTTP. Acceptable
  # here and nowhere else — staging and production both require one.
  certificate_arn            = var.certificate_arn
  enable_deletion_protection = false

  log_group_name     = local.log_group_name
  ssm_parameter_path = local.ssm_parameter_path

  tags = local.common_tags
}

module "frontend" {
  source = "../../modules/frontend"

  name_prefix = local.name_prefix
  bucket_name = local.frontend_bucket_name

  # Build output only — always reproducible from source.
  force_destroy     = true
  enable_versioning = false

  price_class = "PriceClass_100"

  tags = local.common_tags
}

# ── Application configuration ────────────────────────────────────────────────
#
# Non-secret settings live in Parameter Store so they can be changed without an
# infrastructure apply. The instance reads everything under this path into its
# environment file at boot. Secrets never appear here — those come from Secrets
# Manager at runtime.

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

    # Off in development: signature verification requires clients to sign every
    # request, which makes manual testing with curl impractical. It is
    # mandatory on mainnet — see backend/.env.example.
    SIGNATURE_VERIFICATION_ENABLED = "false"
  }

  name  = "${local.ssm_parameter_path}/${each.key}"
  type  = "String"
  value = each.value

  tags = local.common_tags
}
