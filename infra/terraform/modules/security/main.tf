/**
 * Security module — security groups and the application's IAM role.
 *
 * Two ideas run through this module:
 *
 *  1. **Security groups reference each other, never CIDRs.** The application
 *     group accepts traffic from the load balancer's *group*, not from the
 *     VPC range. Adding a subnet later cannot silently widen access.
 *
 *  2. **The instance role is scoped to named resources.** It can read exactly
 *     one secret and write to exactly one bucket prefix. The backup script
 *     needs S3 write and the signing key needs Secrets Manager read; nothing
 *     in the application needs anything broader, so nothing broader is granted.
 */

# ── Security groups ──────────────────────────────────────────────────────────

resource "aws_security_group" "alb" {
  name_prefix = "${var.name_prefix}-alb-"
  description = "Public entry point. Terminates TLS and forwards to the application."
  vpc_id      = var.vpc_id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-alb"
  })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  for_each = toset(var.allowed_ingress_cidrs)

  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from ${each.value}"
  cidr_ipv4         = each.value
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"

  tags = var.tags
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  # Port 80 exists only to redirect to 443 — see the listener in the compute
  # module. It is enabled separately so an environment can drop plain HTTP
  # entirely rather than relying on the redirect.
  for_each = var.enable_http_redirect ? toset(var.allowed_ingress_cidrs) : toset([])

  security_group_id = aws_security_group.alb.id
  description       = "HTTP from ${each.value}, redirected to HTTPS"
  cidr_ipv4         = each.value
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"

  tags = var.tags
}

resource "aws_vpc_security_group_egress_rule" "alb_to_app" {
  security_group_id            = aws_security_group.alb.id
  description                  = "Forward to the application on its listen port"
  referenced_security_group_id = aws_security_group.app.id
  from_port                    = var.app_port
  to_port                      = var.app_port
  ip_protocol                  = "tcp"

  tags = var.tags
}

resource "aws_security_group" "app" {
  name_prefix = "${var.name_prefix}-app-"
  description = "Application instances. Reachable only from the load balancer."
  vpc_id      = var.vpc_id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-app"
  })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "app_from_alb" {
  security_group_id            = aws_security_group.app.id
  description                  = "API traffic from the load balancer"
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = var.app_port
  to_port                      = var.app_port
  ip_protocol                  = "tcp"

  tags = var.tags
}

resource "aws_vpc_security_group_egress_rule" "app_https" {
  # Outbound HTTPS covers Horizon, Soroban RPC, Secrets Manager, S3, and
  # CloudWatch. Everything the application talks to speaks TLS.
  security_group_id = aws_security_group.app.id
  description       = "Horizon, Soroban RPC, and AWS APIs"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"

  tags = var.tags
}

resource "aws_vpc_security_group_egress_rule" "app_dns_udp" {
  security_group_id = aws_security_group.app.id
  description       = "DNS resolution"
  cidr_ipv4         = var.vpc_cidr
  from_port         = 53
  to_port           = 53
  ip_protocol       = "udp"

  tags = var.tags
}

resource "aws_vpc_security_group_egress_rule" "app_smtp" {
  # The digest and compliance-report jobs send mail through nodemailer. Only
  # opened where an SMTP host is actually configured.
  count = var.smtp_egress_port == null ? 0 : 1

  security_group_id = aws_security_group.app.id
  description       = "SMTP for digest and compliance-report delivery"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = var.smtp_egress_port
  to_port           = var.smtp_egress_port
  ip_protocol       = "tcp"

  tags = var.tags
}

# ── Instance role ────────────────────────────────────────────────────────────

resource "aws_iam_role" "app" {
  name_prefix = "${var.name_prefix}-app-"
  description = "Role assumed by the application instances."

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = var.tags
}

resource "aws_iam_instance_profile" "app" {
  name_prefix = "${var.name_prefix}-app-"
  role        = aws_iam_role.app.name

  tags = var.tags
}

data "aws_iam_policy_document" "app" {
  # Read the signing key. Scoped to the one secret this environment owns —
  # `backend/src/secrets-manager.js` reads exactly this and nothing else.
  dynamic "statement" {
    for_each = var.signing_key_secret_arn == null ? [] : [var.signing_key_secret_arn]

    content {
      sid       = "ReadSigningKey"
      effect    = "Allow"
      actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      resources = [statement.value]
    }
  }

  # Write backups. `scripts/automated-backup.sh` uploads under daily/, weekly/,
  # and monthly/; `scripts/backup-monitoring.sh` lists and reads them back.
  dynamic "statement" {
    for_each = var.backup_bucket_arn == null ? [] : [var.backup_bucket_arn]

    content {
      sid       = "WriteBackups"
      effect    = "Allow"
      actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
      resources = ["${statement.value}/*"]
    }
  }

  dynamic "statement" {
    for_each = var.backup_bucket_arn == null ? [] : [var.backup_bucket_arn]

    content {
      sid       = "ListBackupBucket"
      effect    = "Allow"
      actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
      resources = [statement.value]
    }
  }

  # Decrypt backups written under the environment's own CMK.
  dynamic "statement" {
    for_each = var.kms_key_arn == null ? [] : [var.kms_key_arn]

    content {
      sid       = "UseBackupKey"
      effect    = "Allow"
      actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
      resources = [statement.value]
    }
  }

  statement {
    sid    = "WriteLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    ]
    resources = ["arn:aws:logs:*:*:log-group:${var.log_group_name}:*"]
  }

  statement {
    sid       = "PublishMetrics"
    effect    = "Allow"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]

    # PutMetricData cannot be scoped by resource, so it is scoped by namespace
    # instead — the instance can publish its own metrics and nothing else.
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = [var.metrics_namespace]
    }
  }
}

resource "aws_iam_role_policy" "app" {
  name_prefix = "${var.name_prefix}-app-"
  role        = aws_iam_role.app.id
  policy      = data.aws_iam_policy_document.app.json
}

resource "aws_iam_role_policy_attachment" "ssm" {
  # SSM Session Manager replaces SSH: no key pairs to distribute or rotate, no
  # port 22 open anywhere, and every session is logged by CloudTrail. This is
  # the only interactive access path to a private instance.
  count = var.enable_ssm_access ? 1 : 0

  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}
