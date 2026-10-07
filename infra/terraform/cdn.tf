# CDN configuration for frontend assets global distribution (#944)
#
# Deploys frontend build artifacts to CloudFront with:
# - Edge location caching (js/css 1 year, HTML 5 minutes)
# - Gzip/Brotli compression
# - Geographic routing to nearest edge
# - Automatic cache invalidation on deploy
# - Performance monitoring and latency tracking

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# S3 bucket for frontend assets
resource "aws_s3_bucket" "frontend_assets" {
  bucket = "${var.project_name}-frontend-assets-${var.environment}"

  tags = merge(
    var.common_tags,
    {
      Name    = "Frontend Assets Bucket"
      Purpose = "CDN origin for frontend build artifacts"
    }
  )
}

# Block public access initially; CloudFront OAI handles access
resource "aws_s3_bucket_public_access_block" "frontend_assets" {
  bucket = aws_s3_bucket.frontend_assets.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Enable versioning for safer deployments
resource "aws_s3_bucket_versioning" "frontend_assets" {
  bucket = aws_s3_bucket.frontend_assets.id

  versioning_configuration {
    status = "Enabled"
  }
}

# S3 bucket lifecycle to clean old versions after 30 days
resource "aws_s3_bucket_lifecycle_configuration" "frontend_assets" {
  bucket = aws_s3_bucket.frontend_assets.id

  rule {
    id     = "delete_old_versions"
    status = "Enabled"

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

# CloudFront Origin Access Identity (OAI) for S3 access
resource "aws_cloudfront_origin_access_identity" "frontend_oai" {
  comment = "OAI for ${var.project_name} frontend assets"
}

# S3 bucket policy allowing CloudFront to read
resource "aws_s3_bucket_policy" "frontend_assets_policy" {
  bucket = aws_s3_bucket.frontend_assets.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "CloudFrontAccess"
        Effect = "Allow"
        Principal = {
          AWS = aws_cloudfront_origin_access_identity.frontend_oai.iam_arn
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.frontend_assets.arn}/*"
      }
    ]
  })
}

# CloudFront cache policy for static assets (js/css)
resource "aws_cloudfront_cache_policy" "static_assets" {
  name        = "${var.project_name}-static-assets-${var.environment}"
  comment     = "Cache policy for JS/CSS assets (1 year TTL)"
  default_ttl = 31536000 # 1 year in seconds
  max_ttl     = 31536000
  min_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true

    query_strings {
      query_string_behavior = "none"
    }

    headers {
      header_behavior = "none"
    }

    cookies {
      cookie_behavior = "none"
    }
  }
}

# CloudFront cache policy for HTML (short TTL)
resource "aws_cloudfront_cache_policy" "html_policy" {
  name        = "${var.project_name}-html-${var.environment}"
  comment     = "Cache policy for HTML files (5 minute TTL)"
  default_ttl = 300 # 5 minutes
  max_ttl     = 300
  min_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true

    query_strings {
      query_string_behavior = "none"
    }

    headers {
      header_behavior = "none"
    }

    cookies {
      cookie_behavior = "none"
    }
  }
}

# Origin request policy (minimal headers)
resource "aws_cloudfront_origin_request_policy" "frontend_policy" {
  name    = "${var.project_name}-frontend-origin-request-${var.environment}"
  comment = "Forward minimal headers to origin"

  query_strings_config {
    query_string_behavior = "none"
  }

  headers_config {
    header_behavior = "none"
  }

  cookies_config {
    cookie_behavior = "none"
  }
}

# Response headers policy for security and compression
resource "aws_cloudfront_response_headers_policy" "frontend_headers" {
  name    = "${var.project_name}-frontend-headers-${var.environment}"
  comment = "Security and caching headers for frontend"

  custom_headers_config {
    items = [
      {
        header   = "Cache-Control"
        override = false
        value    = "public, max-age=31536000, immutable"
      }
    ]
  }

  security_headers_config {
    strict_transport_security {
      access_control_max_age_override = 31536000
      include_subdomains              = true
      override                        = true
    }

    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    xss_protection {
      mode_block = true
      override   = true
      protection = true
    }
  }
}

# CloudFront distribution
resource "aws_cloudfront_distribution" "frontend_cdn" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  http_version        = "http2and3"
  price_class         = var.cdn_price_class # Controls edge locations (PriceClass_All for global)

  origin {
    domain_name            = aws_s3_bucket.frontend_assets.bucket_regional_domain_name
    origin_id              = "S3FrontendOrigin"
    origin_access_identity = aws_cloudfront_origin_access_identity.frontend_oai.cloudfront_access_identity_path

    # Custom headers for tracking origin requests
    custom_header {
      name  = "X-Origin-Verify"
      value = var.cdn_origin_verification_token
    }
  }

  # Default behavior (HTML files)
  default_cache_behavior {
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3FrontendOrigin"

    cache_policy_id            = aws_cloudfront_cache_policy.html_policy.id
    origin_request_policy_id   = aws_cloudfront_origin_request_policy.frontend_policy.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.frontend_headers.id

    compress = true

    viewer_protocol_policy = "redirect-to-https"
  }

  # Cached behavior for JS/CSS assets (based on file extension)
  ordered_cache_behavior {
    path_pattern     = "*.js"
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3FrontendOrigin"

    cache_policy_id            = aws_cloudfront_cache_policy.static_assets.id
    origin_request_policy_id   = aws_cloudfront_origin_request_policy.frontend_policy.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.frontend_headers.id

    compress = true

    viewer_protocol_policy = "redirect-to-https"
  }

  ordered_cache_behavior {
    path_pattern     = "*.css"
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3FrontendOrigin"

    cache_policy_id            = aws_cloudfront_cache_policy.static_assets.id
    origin_request_policy_id   = aws_cloudfront_origin_request_policy.frontend_policy.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.frontend_headers.id

    compress = true

    viewer_protocol_policy = "redirect-to-https"
  }

  ordered_cache_behavior {
    path_pattern     = "*.svg"
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3FrontendOrigin"

    cache_policy_id            = aws_cloudfront_cache_policy.static_assets.id
    origin_request_policy_id   = aws_cloudfront_origin_request_policy.frontend_policy.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.frontend_headers.id

    compress = true

    viewer_protocol_policy = "redirect-to-https"
  }

  # Asset files (longer cache)
  ordered_cache_behavior {
    path_pattern     = "assets/*"
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3FrontendOrigin"

    cache_policy_id            = aws_cloudfront_cache_policy.static_assets.id
    origin_request_policy_id   = aws_cloudfront_origin_request_policy.frontend_policy.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.frontend_headers.id

    compress = true

    viewer_protocol_policy = "redirect-to-https"
  }

  # Georestrictions (optional - restrict by country if needed)
  # restrictions {
  #   geo_restriction {
  #     restriction_type = "none"
  #   }
  # }

  viewer_certificate {
    cloudfront_default_certificate = var.cdn_certificate_arn == null ? true : false
    acm_certificate_arn            = var.cdn_certificate_arn
    ssl_support_method             = var.cdn_certificate_arn != null ? "sni-only" : null
    minimum_protocol_version       = var.cdn_certificate_arn != null ? "TLSv1.2_2021" : null
  }

  # Access logs for monitoring
  logging_config {
    include_cookies = false
    bucket          = aws_s3_bucket.cdn_logs.bucket_domain_name
    prefix          = "cloudfront/"
  }

  tags = merge(
    var.common_tags,
    {
      Name    = "Frontend CDN Distribution"
      Purpose = "Global edge delivery for frontend assets"
    }
  )

  depends_on = [aws_s3_bucket_policy.frontend_assets_policy]
}

# S3 bucket for CloudFront access logs
resource "aws_s3_bucket" "cdn_logs" {
  bucket = "${var.project_name}-cdn-logs-${var.environment}"

  tags = merge(
    var.common_tags,
    {
      Name    = "CDN Logs Bucket"
      Purpose = "CloudFront access logs storage"
    }
  )
}

# Lifecycle for CDN logs (delete after 90 days)
resource "aws_s3_bucket_lifecycle_configuration" "cdn_logs" {
  bucket = aws_s3_bucket.cdn_logs.id

  rule {
    id     = "delete_old_logs"
    status = "Enabled"

    expiration {
      days = 90
    }
  }
}

# CloudWatch alarms for CDN monitoring
resource "aws_cloudwatch_metric_alarm" "cdn_4xx_errors" {
  alarm_name          = "${var.project_name}-cdn-4xx-errors-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "1"
  metric_name         = "4xxErrorRate"
  namespace           = "AWS/CloudFront"
  period              = "300"
  statistic           = "Average"
  threshold           = "5"
  alarm_description   = "Alert when CDN 4xx error rate exceeds 5%"

  dimensions = {
    DistributionId = aws_cloudfront_distribution.frontend_cdn.id
  }
}

resource "aws_cloudwatch_metric_alarm" "cdn_5xx_errors" {
  alarm_name          = "${var.project_name}-cdn-5xx-errors-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "1"
  metric_name         = "5xxErrorRate"
  namespace           = "AWS/CloudFront"
  period              = "300"
  statistic           = "Average"
  threshold           = "1"
  alarm_description   = "Alert when CDN 5xx error rate exceeds 1%"

  dimensions = {
    DistributionId = aws_cloudfront_distribution.frontend_cdn.id
  }
}

# Outputs for deployment and monitoring
output "cloudfront_domain_name" {
  description = "CloudFront distribution domain name"
  value       = aws_cloudfront_distribution.frontend_cdn.domain_name
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID (for cache invalidation)"
  value       = aws_cloudfront_distribution.frontend_cdn.id
}

output "cloudfront_distribution_arn" {
  description = "CloudFront distribution ARN"
  value       = aws_cloudfront_distribution.frontend_cdn.arn
}

output "s3_bucket_name" {
  description = "S3 bucket name for frontend assets"
  value       = aws_s3_bucket.frontend_assets.id
}

output "cdn_price_class" {
  description = "CloudFront price class (edge location coverage)"
  value       = var.cdn_price_class
}

output "cdn_logs_bucket" {
  description = "S3 bucket for CloudFront logs"
  value       = aws_s3_bucket.cdn_logs.id
}
