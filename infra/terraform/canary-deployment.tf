/**
 * Canary deployment routing (#936).
 *
 * The API writes one SQLite file on one EBS volume, so a canary cannot be a
 * second host. It runs as a second process on the same instance — stable on
 * app_port (3001), canary on canary_port (3002) — both using the same database
 * in WAL mode. The ALB splits traffic between two target groups that point at
 * those ports:
 *
 *                 ┌── weight 100-N ──▶ stable TG ──▶ instance:3001
 *   listener ─────┤
 *    rule         └── weight N ──────▶ canary TG ──▶ instance:3002
 *
 * Terraform creates the rule at 100/0 and then ignores its weights:
 * infra/canary-controller.js owns them during a rollout (1% → 5% → 25% →
 * 100%, or back to 0% on rollback). A `terraform apply` mid-rollout therefore
 * never yanks traffic back.
 *
 * Because both versions share the database, schema migrations must be
 * backward compatible (expand → deploy → contract); see
 * docs/canary-deployment.md.
 */

variable "enable_canary" {
  description = "Create the canary target group, weighted listener rule and canary alarms."
  type        = bool
  default     = true
}

variable "vpc_id" {
  description = "The environment's `vpc_id` output."
  type        = string
  default     = ""
}

variable "listener_arn" {
  description = "The environment's `listener_arn` output (the serving listener)."
  type        = string
  default     = ""
}

variable "stable_target_group_arn" {
  description = "The environment's `target_group_arn` output."
  type        = string
  default     = ""
}

variable "autoscaling_group_name" {
  description = "The environment's `autoscaling_group_name` output. Its instance is registered in the canary target group on canary_port."
  type        = string
  default     = ""
}

variable "alb_security_group_id" {
  description = "The environment's `alb_security_group_id` output."
  type        = string
  default     = ""
}

variable "app_security_group_id" {
  description = "The environment's `app_security_group_id` output."
  type        = string
  default     = ""
}

variable "alb_arn_suffix" {
  description = "The environment's `alb_arn_suffix` output, for CloudWatch dimensions."
  type        = string
  default     = ""
}

variable "canary_port" {
  description = "Port the canary API process listens on."
  type        = number
  default     = 3002
}

variable "canary_rule_priority" {
  description = "Listener rule priority. Must be unique on the listener; the rule matches every path."
  type        = number
  default     = 10
}

variable "canary_health_check_path" {
  description = "Health check for the canary target group."
  type        = string
  default     = "/health"
}

variable "canary_max_error_rate" {
  description = "Canary 5xx ratio that raises the CloudWatch alarm (the controller rolls back on its own threshold first)."
  type        = number
  default     = 0.05
}

variable "canary_max_p95_latency_seconds" {
  description = "Canary p95 target response time that raises the CloudWatch alarm."
  type        = number
  default     = 2
}

variable "deployer_role_name" {
  description = "IAM role the deploy workflow assumes (OIDC). Granted exactly the ELB permissions the canary controller needs. Empty skips the attachment; the policy JSON is still output."
  type        = string
  default     = ""
}

locals {
  canary_enabled = var.enable_canary && var.listener_arn != "" && var.stable_target_group_arn != ""
}

resource "aws_lb_target_group" "canary" {
  count = local.canary_enabled ? 1 : 0

  name_prefix = "cnry-"
  port        = var.canary_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "instance"

  # Short drain: during a rollback we want the canary out of rotation fast.
  deregistration_delay = 15

  health_check {
    path                = var.canary_health_check_path
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "${var.name_prefix}-canary-tg" }
}

# The same instance(s) that serve stable are registered again on canary_port.
resource "aws_autoscaling_attachment" "canary" {
  count = local.canary_enabled && var.autoscaling_group_name != "" ? 1 : 0

  autoscaling_group_name = var.autoscaling_group_name
  lb_target_group_arn    = aws_lb_target_group.canary[0].arn
}

resource "aws_vpc_security_group_ingress_rule" "app_canary_from_alb" {
  count = local.canary_enabled && var.app_security_group_id != "" && var.alb_security_group_id != "" ? 1 : 0

  security_group_id            = var.app_security_group_id
  referenced_security_group_id = var.alb_security_group_id
  from_port                    = var.canary_port
  to_port                      = var.canary_port
  ip_protocol                  = "tcp"
  description                  = "Canary API from the load balancer (#936)"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_app_canary" {
  count = local.canary_enabled && var.app_security_group_id != "" && var.alb_security_group_id != "" ? 1 : 0

  security_group_id            = var.alb_security_group_id
  referenced_security_group_id = var.app_security_group_id
  from_port                    = var.canary_port
  to_port                      = var.canary_port
  ip_protocol                  = "tcp"
  description                  = "Load balancer to canary API (#936)"
}

resource "aws_lb_listener_rule" "canary" {
  count = local.canary_enabled ? 1 : 0

  listener_arn = var.listener_arn
  priority     = var.canary_rule_priority

  action {
    type = "forward"

    forward {
      target_group {
        arn    = var.stable_target_group_arn
        weight = 100
      }

      target_group {
        arn    = aws_lb_target_group.canary[0].arn
        weight = 0
      }

      stickiness {
        enabled  = false
        duration = 1
      }
    }
  }

  condition {
    path_pattern {
      values = ["/*"]
    }
  }

  lifecycle {
    # Weights are owned by infra/canary-controller.js during a rollout.
    ignore_changes = [action]
  }

  tags = { Name = "${var.name_prefix}-canary-split" }
}

# ── Alarms on the canary target group ────────────────────────────────────────
#
# Second line of defence behind the controller: they page a human if the
# canary is unhealthy while still in rotation (e.g. the controller died).

resource "aws_cloudwatch_metric_alarm" "canary_error_rate" {
  count = local.canary_enabled && var.alb_arn_suffix != "" ? 1 : 0

  alarm_name          = "${var.name_prefix}-canary-error-rate"
  alarm_description   = "Canary 5xx ratio above ${var.canary_max_error_rate * 100}% while in rotation. Roll back: node infra/canary-controller.js set-weight 0 --router alb ... (#936)"
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.canary_max_error_rate
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alert_topic_arn]
  ok_actions          = [var.alert_topic_arn]

  metric_query {
    id          = "ratio"
    expression  = "IF(requests > 20, errors / requests, 0)"
    label       = "Canary 5xx ratio"
    return_data = true
  }

  metric_query {
    id = "errors"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      stat        = "Sum"
      period      = 60
      dimensions = {
        LoadBalancer = var.alb_arn_suffix
        TargetGroup  = aws_lb_target_group.canary[0].arn_suffix
      }
    }
  }

  metric_query {
    id = "requests"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      stat        = "Sum"
      period      = 60
      dimensions = {
        LoadBalancer = var.alb_arn_suffix
        TargetGroup  = aws_lb_target_group.canary[0].arn_suffix
      }
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "canary_latency" {
  count = local.canary_enabled && var.alb_arn_suffix != "" ? 1 : 0

  alarm_name          = "${var.name_prefix}-canary-latency"
  alarm_description   = "Canary p95 response time above ${var.canary_max_p95_latency_seconds}s while in rotation (#936)."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  extended_statistic  = "p95"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  threshold           = var.canary_max_p95_latency_seconds
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alert_topic_arn]
  ok_actions          = [var.alert_topic_arn]

  dimensions = {
    LoadBalancer = var.alb_arn_suffix
    TargetGroup  = aws_lb_target_group.canary[0].arn_suffix
  }
}

# ── What the deploy pipeline may do ──────────────────────────────────────────

data "aws_iam_policy_document" "canary_controller" {
  count = local.canary_enabled ? 1 : 0

  statement {
    sid       = "ShiftCanaryWeights"
    actions   = ["elasticloadbalancing:ModifyRule"]
    resources = [aws_lb_listener_rule.canary[0].arn]
  }

  statement {
    sid = "ObserveTargets"
    actions = [
      "elasticloadbalancing:DescribeRules",
      "elasticloadbalancing:DescribeTargetHealth",
      "elasticloadbalancing:DescribeTargetGroups",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "canary_controller" {
  count = local.canary_enabled && var.deployer_role_name != "" ? 1 : 0

  name   = "${var.name_prefix}-canary-controller"
  role   = var.deployer_role_name
  policy = data.aws_iam_policy_document.canary_controller[0].json
}

output "canary_rule_arn" {
  description = "Listener rule whose weights the canary controller shifts (CANARY_RULE_ARN in the deploy workflow)."
  value       = local.canary_enabled ? aws_lb_listener_rule.canary[0].arn : null
}

output "canary_target_group_arn" {
  description = "Canary target group (CANARY_TARGET_GROUP_ARN in the deploy workflow)."
  value       = local.canary_enabled ? aws_lb_target_group.canary[0].arn : null
}

output "canary_controller_policy_json" {
  description = "Least-privilege policy for whatever runs the canary controller."
  value       = local.canary_enabled ? data.aws_iam_policy_document.canary_controller[0].json : null
}
