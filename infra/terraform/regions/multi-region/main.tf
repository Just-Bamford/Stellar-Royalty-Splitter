/**
 * Multi-region regional backend stack module (#934).
 *
 * Provisions a complete regional backend stack deployable across US and EU regions:
 *   - Regional VPC with public and private subnets, NAT gateway, and routing
 *   - Security groups for load balancing and compute
 *   - Regional KMS key and encrypted EBS data volume for SQLite
 *   - Regional S3 backup bucket with versioning (replication target/source)
 *   - Application Load Balancer with /health check target group
 *   - HTTP API Gateway fronting the backend for latency-based & geographical routing
 *   - EC2 launch template & auto-scaling group running Express API
 *   - Synced regional Stellar Horizon and Soroban RPC endpoint configurations
 */

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_caller_identity" "current" {}

data "aws_ami" "amazon_linux" {
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
  account_id = data.aws_caller_identity.current.account_id
  azs        = slice(data.aws_availability_zones.available.names, 0, var.availability_zone_count)

  common_tags = merge(var.tags, {
    Environment = var.environment
    Region      = var.aws_region
    Role        = var.is_primary ? "primary" : "replica"
    ManagedBy   = "terraform"
  })

  user_data = base64encode(<<-EOF
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Bootstrapping Stellar Royalty Splitter (${var.aws_region}) - Role: ${var.is_primary ? "PRIMARY" : "REPLICA"}"
    export AWS_REGION="${var.aws_region}"
    export NODE_ENV="${var.environment}"
    export PORT="${var.app_port}"
    export DATABASE_PATH="${var.database_path}"
    export IS_PRIMARY="${var.is_primary}"
    export SOROBAN_RPC_URL="${var.soroban_rpc_url}"
    export HORIZON_URL="${var.horizon_url}"
    export BACKUP_S3_BUCKET="${aws_s3_bucket.backups.id}"
    export BACKUP_S3_REGION="${var.aws_region}"
  EOF
  )
}

# ── Networking ────────────────────────────────────────────────────────────────

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-vpc"
  })
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-igw"
  })
}

resource "aws_subnet" "public" {
  count             = length(local.azs)
  vpc_id            = aws_vpc.main.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index)
  map_public_ip_on_launch = true

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-public-${local.azs[count.index]}"
    Tier = "public"
  })
}

resource "aws_subnet" "private" {
  count             = length(local.azs)
  vpc_id            = aws_vpc.main.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 10)

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-private-${local.azs[count.index]}"
    Tier = "private"
  })
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-nat-eip"
  })
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-nat"
  })

  depends_on = [aws_internet_gateway.main]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-public-rt"
  })
}

resource "aws_route_table_association" "public" {
  count          = length(local.azs)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-private-rt"
  })
}

resource "aws_route_table_association" "private" {
  count          = length(local.azs)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# ── Security & IAM ────────────────────────────────────────────────────────────

resource "aws_security_group" "alb" {
  name_prefix = "${var.name_prefix}-alb-"
  description = "Ingress for regional load balancer"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTP ingress"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS ingress"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Egress to application instances"
    from_port   = var.app_port
    to_port     = var.app_port
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-alb-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "app" {
  name_prefix = "${var.name_prefix}-app-"
  description = "Security group for backend instances"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Inbound from regional ALB"
    from_port       = var.app_port
    to_port         = var.app_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    description = "Outbound egress for Stellar Horizon, RPC, and S3"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-app-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_iam_role" "instance" {
  name_prefix = "${var.name_prefix}-instance-"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_policy" "s3_access" {
  name_prefix = "${var.name_prefix}-s3-"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.backups.arn,
          "${aws_s3_bucket.backups.arn}/*"
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "s3" {
  role       = aws_iam_role.instance.name
  policy_arn = aws_iam_policy.s3_access.arn
}

resource "aws_iam_instance_profile" "instance" {
  name_prefix = "${var.name_prefix}-"
  role        = aws_iam_role.instance.name
}

# ── Storage ───────────────────────────────────────────────────────────────────

resource "aws_kms_key" "main" {
  description             = "${var.name_prefix} regional encryption key"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-key"
  })
}

resource "aws_kms_alias" "main" {
  name          = "alias/${var.name_prefix}"
  target_key_id = aws_kms_key.main.key_id
}

resource "aws_s3_bucket" "backups" {
  bucket = "${var.name_prefix}-backups-${local.account_id}"

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-backups-${local.account_id}"
  })
}

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_ebs_volume" "data" {
  availability_zone = local.azs[0]
  size              = var.data_volume_size_gb
  type              = "gp3"
  encrypted         = true
  kms_key_id        = aws_kms_key.main.arn

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-data"
    Role = var.is_primary ? "database-primary" : "database-replica"
  })
}

# ── Compute (ALB & Auto-scaling) ──────────────────────────────────────────────

resource "aws_lb" "main" {
  name_prefix        = substr(var.name_prefix, 0, 6)
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  enable_deletion_protection = false
  drop_invalid_header_fields = true

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-alb"
  })
}

resource "aws_lb_target_group" "app" {
  name_prefix = substr(var.name_prefix, 0, 6)
  port        = var.app_port
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "instance"

  health_check {
    enabled             = true
    path                = "/health"
    port                = tostring(var.app_port)
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-tg"
  })
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

resource "aws_launch_template" "app" {
  name_prefix   = "${var.name_prefix}-lt-"
  image_id      = data.aws_ami.amazon_linux.id
  instance_type = var.instance_type

  iam_instance_profile {
    name = aws_iam_instance_profile.instance.name
  }

  network_interfaces {
    associate_public_ip_address = false
    security_groups             = [aws_security_group.app.id]
  }

  user_data = local.user_data

  tags = local.common_tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_autoscaling_group" "app" {
  name_prefix         = "${var.name_prefix}-asg-"
  vpc_zone_identifier = [aws_subnet.private[0].id]
  target_group_arns   = [aws_lb_target_group.app.arn]

  min_size     = 1
  max_size     = 1
  desired_capacity = 1

  launch_template {
    id      = aws_launch_template.app.id
    version = "$Latest"
  }

  instance_refresh {
    strategy = "Rolling"
  }

  tag {
    key                 = "Name"
    value               = "${var.name_prefix}-instance"
    propagate_at_launch = true
  }
}

# ── API Gateway (Regional HTTP API for Geolocation Routing) ───────────────────

resource "aws_apigatewayv2_api" "regional" {
  name          = "${var.name_prefix}-api"
  protocol_type = "HTTP"
  description   = "Regional API Gateway for ${var.aws_region} backend"

  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    allow_headers = ["*"]
    max_age       = 300
  }

  tags = local.common_tags
}

resource "aws_apigatewayv2_integration" "alb" {
  api_id           = aws_apigatewayv2_api.regional.id
  integration_type = "HTTP_PROXY"
  integration_uri  = aws_lb_listener.http.arn
  integration_method = "ANY"
  connection_type  = "INTERNET"
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.regional.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.alb.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.regional.id
  name        = "$default"
  auto_deploy = true

  tags = local.common_tags
}

# ── Synced Stellar RPC Configuration ──────────────────────────────────────────

resource "aws_ssm_parameter" "soroban_rpc_url" {
  name  = "/${var.name_prefix}/stellar/soroban_rpc_url"
  type  = "String"
  value = var.soroban_rpc_url

  tags = local.common_tags
}

resource "aws_ssm_parameter" "horizon_url" {
  name  = "/${var.name_prefix}/stellar/horizon_url"
  type  = "String"
  value = var.horizon_url

  tags = local.common_tags
}
