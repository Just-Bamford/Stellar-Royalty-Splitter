/**
 * Multi-region deployment with failover (#934).
 *
 * Configures geographically redundant backend stacks across US (us-east-1)
 * and EU (eu-west-1):
 *   - US Region: Primary write stack running backend API, single-writer SQLite,
 *     and primary database snapshot/WAL generation.
 *   - EU Region: Read-replica / hot standby stack receiving replicated snapshots
 *     and database journals, capable of serving read traffic and acting as failover.
 *   - Geolocation & Failover DNS Routing:
 *       * Route53 Geolocation routing sends North American traffic to US and
 *         European traffic to EU via regional API Gateway / ALB endpoints.
 *       * Route53 Health-check failover monitors US health (/health). If the US
 *         primary endpoint becomes unresponsive, traffic automatically routes to EU.
 *   - Stellar RPC synchronization: Synced Soroban RPC and Horizon RPC endpoints
 *     configured for low latency in each region.
 */

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.us_region

  default_tags {
    tags = local.common_tags
  }
}

provider "aws" {
  alias  = "eu"
  region = var.eu_region

  default_tags {
    tags = local.common_tags
  }
}

locals {
  common_tags = {
    Project     = "stellar-royalty-splitter"
    Environment = var.environment
    ManagedBy   = "terraform"
    Repository  = "Just-Bamford/Stellar-Royalty-Splitter"
    MultiRegion = "true"
  }
}

# ── Primary US Backend Stack (us-east-1) ──────────────────────────────────────

module "backend_us" {
  source = "./regions/multi-region"

  name_prefix     = "${var.name_prefix}-us"
  aws_region      = var.us_region
  environment     = var.environment
  is_primary      = true
  vpc_cidr        = var.us_vpc_cidr
  app_port        = var.app_port
  soroban_rpc_url = var.us_soroban_rpc_url
  horizon_url     = var.us_horizon_url

  tags = local.common_tags
}

# ── Secondary EU Backend Stack (eu-west-1) ────────────────────────────────────

module "backend_eu" {
  source = "./regions/multi-region"

  providers = {
    aws = aws.eu
  }

  name_prefix     = "${var.name_prefix}-eu"
  aws_region      = var.eu_region
  environment     = var.environment
  is_primary      = false
  vpc_cidr        = var.eu_vpc_cidr
  app_port        = var.app_port
  soroban_rpc_url = var.eu_soroban_rpc_url
  horizon_url     = var.eu_horizon_url

  tags = local.common_tags
}

# ── Route53 Health Checks for Regional Failover ───────────────────────────────

resource "aws_route53_health_check" "us_primary" {
  fqdn              = module.backend_us.alb_dns_name
  port              = 80
  type              = "HTTP"
  resource_path     = "/health"
  failure_threshold = 3
  request_interval  = 30

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-us-primary-health"
  })
}

resource "aws_route53_health_check" "eu_secondary" {
  fqdn              = module.backend_eu.alb_dns_name
  port              = 80
  type              = "HTTP"
  resource_path     = "/health"
  failure_threshold = 3
  request_interval  = 30

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-eu-secondary-health"
  })
}

# ── Geolocation & Failover DNS Routing ────────────────────────────────────────

resource "aws_route53_record" "geo_us" {
  count   = var.route53_zone_id != null && var.domain_name != null ? 1 : 0
  zone_id = var.route53_zone_id
  name    = "api.${var.domain_name}"
  type    = "A"

  set_identifier = "us-americas"

  geolocation_routing_policy {
    continent = "NA"
  }

  alias {
    name                   = module.backend_us.alb_dns_name
    zone_id                = module.backend_us.alb_zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "geo_eu" {
  count   = var.route53_zone_id != null && var.domain_name != null ? 1 : 0
  zone_id = var.route53_zone_id
  name    = "api.${var.domain_name}"
  type    = "A"

  set_identifier = "eu-europe"

  geolocation_routing_policy {
    continent = "EU"
  }

  alias {
    name                   = module.backend_eu.alb_dns_name
    zone_id                = module.backend_eu.alb_zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "geo_default" {
  count   = var.route53_zone_id != null && var.domain_name != null ? 1 : 0
  zone_id = var.route53_zone_id
  name    = "api.${var.domain_name}"
  type    = "A"

  set_identifier = "default-global"

  geolocation_routing_policy {
    country = "*"
  }

  alias {
    name                   = module.backend_us.alb_dns_name
    zone_id                = module.backend_us.alb_zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "failover_primary" {
  count   = var.enable_dns_failover && var.route53_zone_id != null && var.domain_name != null ? 1 : 0
  zone_id = var.route53_zone_id
  name    = "failover.${var.domain_name}"
  type    = "A"

  set_identifier  = "primary-us"
  health_check_id = aws_route53_health_check.us_primary.id

  failover_routing_policy {
    type = "PRIMARY"
  }

  alias {
    name                   = module.backend_us.alb_dns_name
    zone_id                = module.backend_us.alb_zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "failover_secondary" {
  count   = var.enable_dns_failover && var.route53_zone_id != null && var.domain_name != null ? 1 : 0
  zone_id = var.route53_zone_id
  name    = "failover.${var.domain_name}"
  type    = "A"

  set_identifier  = "secondary-eu"
  health_check_id = aws_route53_health_check.eu_secondary.id

  failover_routing_policy {
    type = "SECONDARY"
  }

  alias {
    name                   = module.backend_eu.alb_dns_name
    zone_id                = module.backend_eu.alb_zone_id
    evaluate_target_health = true
  }
}
