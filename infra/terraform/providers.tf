/**
 * Operations stack (#935, #936, #937, #938).
 *
 * The files at this level — audit-service.tf, backup.tf, canary-deployment.tf
 * and grafana.tf — form one root module layered *on top of* an environment in
 * environments/<env>/. The environment owns the network, instance, load
 * balancer and buckets; this stack owns the operational processes that run
 * against them: scheduled backups and recovery tests, canary traffic routing,
 * the compliance audit archive, and dashboard provisioning.
 *
 * It is a separate root so those processes can be changed, planned and
 * applied without touching the environment's state, and so each feature can
 * be switched on per environment with its `enable_*` flag.
 *
 * Inputs come from the environment's outputs (listener_arn, target_group_arn,
 * backup_bucket, alert_topic_arn, …):
 *
 *   terraform -chdir=environments/prod output
 *
 * Copy operations.tfvars.example to prod.tfvars, fill it in from that output,
 * and use a separate state key from the environment's:
 *
 *   terraform init -backend-config=backend.hcl   # key = "operations/prod.tfstate"
 *   terraform plan -var-file=prod.tfvars
 */

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    grafana = {
      source  = "grafana/grafana"
      version = "~> 3.0"
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

# Only exercised when enable_grafana_dashboards is true. The URL and token can
# also come from GRAFANA_URL / GRAFANA_AUTH in the environment.
provider "grafana" {
  url  = var.grafana_url
  auth = var.grafana_auth
}

data "aws_region" "current" {}

# ── Shared inputs ────────────────────────────────────────────────────────────

variable "aws_region" {
  description = "Region the environment lives in."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment name: dev, staging or prod."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging or prod."
  }
}

variable "name_prefix" {
  description = "Resource name prefix used by the environment (e.g. srs-prod)."
  type        = string
}

variable "alert_topic_arn" {
  description = "SNS topic for alarm notifications — the environment's `alert_topic_arn` output."
  type        = string
}

variable "metrics_namespace" {
  description = "CloudWatch namespace the instance publishes to. Must match the security module's metrics_namespace, which is the only namespace the instance role may write."
  type        = string
  default     = "StellarRoyaltySplitter"
}

variable "instance_role_name" {
  description = "The app instance's IAM role — the environment's `instance_role_name` output. Extra grants for the scheduled jobs attach here."
  type        = string
  default     = ""
}

variable "app_directory" {
  description = "Where the application is deployed on the instance (compute module bootstrap)."
  type        = string
  default     = "/opt/stellar-royalty-splitter"
}

variable "tags" {
  description = "Extra tags for every resource."
  type        = map(string)
  default     = {}
}

locals {
  common_tags = merge(var.tags, {
    Project     = "stellar-royalty-splitter"
    Environment = var.environment
    ManagedBy   = "terraform"
    Stack       = "operations"
  })

  # Instances carry Name = "<name_prefix>-app" (compute module launch template).
  instance_name_tag = "${var.name_prefix}-app"

  run_shell_document_arn = "arn:aws:ssm:${data.aws_region.current.name}::document/AWS-RunShellScript"

  # Every scheduled job runs as the app user with the app's environment
  # (secrets and config written by the bootstrap) loaded.
  app_shell_prefix = "cd ${var.app_directory} && set -a && . ${var.app_directory}/.env && set +a &&"
}

# ── Scheduled jobs: EventBridge → SSM Run Command on the app instance ────────
#
# Shared by backup.tf and audit-service.tf. EventBridge can invoke Run Command
# directly, so no Lambda or cron-on-the-box is needed and every run is visible
# in the SSM console with its output.

data "aws_iam_policy_document" "events_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduled_jobs" {
  count = var.enable_backup_automation || var.enable_audit_trail_service ? 1 : 0

  name_prefix        = "${var.name_prefix}-ops-jobs-"
  assume_role_policy = data.aws_iam_policy_document.events_assume.json
}

data "aws_iam_policy_document" "scheduled_jobs" {
  statement {
    sid       = "RunShellScript"
    actions   = ["ssm:SendCommand"]
    resources = [local.run_shell_document_arn]
  }

  statement {
    sid       = "OnTheAppInstancesOnly"
    actions   = ["ssm:SendCommand"]
    resources = ["arn:aws:ec2:${data.aws_region.current.name}:*:instance/*"]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/Name"
      values   = compact(distinct([local.instance_name_tag, var.recovery_test_instance_name_tag]))
    }
  }
}

resource "aws_iam_role_policy" "scheduled_jobs" {
  count = length(aws_iam_role.scheduled_jobs)

  name   = "send-command"
  role   = aws_iam_role.scheduled_jobs[0].id
  policy = data.aws_iam_policy_document.scheduled_jobs.json
}
