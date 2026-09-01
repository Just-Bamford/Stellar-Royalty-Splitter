/**
 * Compute module — load balancer, launch template, and auto-scaling group.
 *
 * The application is a Node process managed by pm2, serving an Express API and
 * writing to a SQLite database on an attached EBS volume. That last part
 * constrains the whole design:
 *
 *  - **SQLite is single-writer.** Two instances writing the same database file
 *    corrupts it, and EBS cannot attach one volume to two instances in the
 *    normal case anyway. The ASG is therefore capped at one instance and the
 *    module refuses a larger maximum. This is a real ceiling on the current
 *    architecture, not a placeholder — horizontal scaling requires migrating
 *    off SQLite first.
 *
 *  - **The ASG exists for recovery, not scale.** min=max=1 means a failed
 *    health check replaces the instance automatically, which is what makes
 *    "loss of application infrastructure" a survivable event rather than an
 *    outage lasting until someone notices.
 *
 * The instance sits in a private subnet. The only inbound path is the ALB; the
 * only interactive path is SSM Session Manager.
 */

data "aws_ami" "amazon_linux" {
  count = var.ami_id == null ? 1 : 0

  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

locals {
  ami_id = var.ami_id != null ? var.ami_id : data.aws_ami.amazon_linux[0].id

  user_data = base64encode(templatefile("${path.module}/templates/user-data.sh.tftpl", {
    aws_region         = var.aws_region
    app_port           = var.app_port
    data_volume_id     = var.data_volume_id == null ? "" : var.data_volume_id
    data_mount_point   = var.data_mount_point
    database_path      = var.database_path
    log_group_name     = var.log_group_name
    metrics_namespace  = var.metrics_namespace
    environment        = var.environment
    ssm_parameter_path = var.ssm_parameter_path
  }))
}

# ── Load balancer ────────────────────────────────────────────────────────────

resource "aws_lb" "main" {
  name_prefix        = substr(var.name_prefix, 0, 6)
  internal           = false
  load_balancer_type = "application"
  security_groups    = [var.alb_security_group_id]
  subnets            = var.public_subnet_ids

  # Production keeps this on so a stray `terraform destroy` cannot remove the
  # public entry point.
  enable_deletion_protection = var.enable_deletion_protection

  # Longer than the backend's REQUEST_TIMEOUT_MS (30 s default) so the
  # application's own timeout fires first and returns a 503 it can log, rather
  # than the ALB cutting the connection with an unattributable 504.
  idle_timeout = var.idle_timeout_seconds

  drop_invalid_header_fields = true

  dynamic "access_logs" {
    for_each = var.access_logs_bucket == null ? [] : [var.access_logs_bucket]

    content {
      bucket  = access_logs.value
      prefix  = var.name_prefix
      enabled = true
    }
  }

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-alb"
  })
}

resource "aws_lb_target_group" "app" {
  name_prefix = substr(var.name_prefix, 0, 6)
  port        = var.app_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "instance"

  health_check {
    enabled = true
    # /api/v1/liveness, not /health: liveness answers from the process alone,
    # while the health endpoint probes Horizon and Soroban RPC. Using the
    # latter would let an upstream Stellar outage cause the ASG to terminate a
    # perfectly healthy instance, turning a degraded dependency into an outage
    # of our own making.
    path                = var.health_check_path
    protocol            = "HTTP"
    matcher             = "200"
    interval            = var.health_check_interval_seconds
    timeout             = var.health_check_timeout_seconds
    healthy_threshold   = 2
    unhealthy_threshold = var.health_check_unhealthy_threshold
  }

  # Long enough for in-flight distribute requests to finish, since those may be
  # polling Horizon for transaction confirmation.
  deregistration_delay = var.deregistration_delay_seconds

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-tg"
  })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_listener" "https" {
  count = var.certificate_arn == null ? 0 : 1

  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = var.ssl_policy
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }

  tags = var.tags
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  # With a certificate, port 80 only redirects. Without one — development, or
  # before DNS is set up — it serves directly, because an environment that
  # cannot be reached at all is not useful.
  dynamic "default_action" {
    for_each = var.certificate_arn == null ? [] : [1]

    content {
      type = "redirect"

      redirect {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }

  dynamic "default_action" {
    for_each = var.certificate_arn == null ? [1] : []

    content {
      type             = "forward"
      target_group_arn = aws_lb_target_group.app.arn
    }
  }

  tags = var.tags
}

# ── Instances ────────────────────────────────────────────────────────────────

resource "aws_launch_template" "app" {
  name_prefix   = "${var.name_prefix}-"
  image_id      = local.ami_id
  instance_type = var.instance_type

  iam_instance_profile {
    name = var.instance_profile_name
  }

  vpc_security_group_ids = [var.app_security_group_id]

  user_data = local.user_data

  block_device_mappings {
    device_name = "/dev/xvda"

    ebs {
      volume_size           = var.root_volume_size_gb
      volume_type           = "gp3"
      encrypted             = true
      kms_key_id            = var.kms_key_arn
      delete_on_termination = true
    }
  }

  metadata_options {
    # IMDSv2 only. IMDSv1 is reachable through an SSRF in the application and
    # would hand out the instance role's credentials.
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  monitoring {
    enabled = var.enable_detailed_monitoring
  }

  tag_specifications {
    resource_type = "instance"

    tags = merge(var.tags, {
      Name = "${var.name_prefix}-app"
    })
  }

  tag_specifications {
    resource_type = "volume"
    tags          = var.tags
  }

  tags = var.tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_autoscaling_group" "app" {
  name_prefix = "${var.name_prefix}-"

  # See the module header: SQLite is single-writer, so this is capped at one.
  min_size         = var.min_size
  max_size         = var.max_size
  desired_capacity = var.desired_capacity

  # The instance must land in the AZ holding the data volume — EBS cannot
  # cross AZs, so an instance started anywhere else could not attach it. When
  # a specific subnet is pinned the ASG is restricted to it; otherwise it may
  # use any private subnet.
  vpc_zone_identifier = var.data_volume_subnet_id == null ? var.private_subnet_ids : [var.data_volume_subnet_id]

  target_group_arns = [aws_lb_target_group.app.arn]

  # ELB health, not just EC2 status: a wedged Node process keeps the instance
  # "running" while serving nothing.
  health_check_type = "ELB"
  # Generous enough for the volume attach, filesystem mount, dependency
  # install, and pm2 start in user-data to complete before the first check.
  health_check_grace_period = var.health_check_grace_period_seconds

  launch_template {
    id      = aws_launch_template.app.id
    version = "$Latest"
  }

  dynamic "instance_refresh" {
    for_each = var.enable_instance_refresh ? [1] : []

    content {
      strategy = "Rolling"

      preferences {
        # At one instance there is no way to keep capacity during a refresh;
        # the replacement is a brief interruption. Stated explicitly so the
        # behaviour is not a surprise during a deploy.
        min_healthy_percentage = 0
        instance_warmup        = var.health_check_grace_period_seconds
      }
    }
  }

  tag {
    key                 = "Name"
    value               = "${var.name_prefix}-app"
    propagate_at_launch = true
  }

  dynamic "tag" {
    for_each = var.tags

    content {
      key                 = tag.key
      value               = tag.value
      propagate_at_launch = true
    }
  }

  lifecycle {
    create_before_destroy = true
  }
}
