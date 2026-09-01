/**
 * Frontend module — S3 origin and CloudFront distribution for the Vite build.
 *
 * `frontend/` builds to a static `dist/` (see its `npm run build`), so the
 * hosting question is only how to serve files. The bucket is private and
 * reachable exclusively through CloudFront via Origin Access Control; there is
 * no website endpoint and no public bucket policy.
 *
 * Two details matter for a single-page app specifically:
 *
 *  - **404 and 403 are rewritten to `/index.html` with a 200.** Client-side
 *    routing means a deep link like `/contract/C...` has no corresponding S3
 *    object; without the rewrite it would 403 rather than load the app.
 *
 *  - **`index.html` is never cached at the edge, hashed assets are cached
 *    forever.** Vite fingerprints asset filenames, so they are immutable and
 *    safe to cache for a year, while `index.html` is the file that points at
 *    the current build and must not be stale after a deploy.
 */

locals {
  origin_id = "${var.name_prefix}-s3-origin"
}

resource "aws_s3_bucket" "frontend" {
  bucket = var.bucket_name

  # The bucket holds only build output, which is reproducible from source, so
  # deleting a non-empty bucket destroys nothing that cannot be rebuilt.
  force_destroy = var.force_destroy

  tags = merge(var.tags, {
    Name = var.bucket_name
  })
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  versioning_configuration {
    # Makes rolling back a bad frontend deploy a matter of restoring the
    # previous object versions rather than rebuilding from a git tag.
    status = var.enable_versioning ? "Enabled" : "Suspended"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${var.name_prefix}-oac"
  description                       = "Origin access control for ${var.bucket_name}"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "frontend" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  comment             = "${var.name_prefix} frontend"
  price_class         = var.price_class
  aliases             = var.domain_aliases
  web_acl_id          = var.web_acl_arn

  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = local.origin_id
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  default_cache_behavior {
    target_origin_id       = local.origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    # CachingOptimized — the AWS managed policy. Overridden below for
    # index.html, which must not be cached.
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"

    response_headers_policy_id = var.response_headers_policy_id
  }

  ordered_cache_behavior {
    # index.html points at the current build. Caching it at the edge means a
    # deploy is invisible until the TTL expires, so it is never cached.
    path_pattern           = "/index.html"
    target_origin_id       = local.origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    # CachingDisabled — the AWS managed policy.
    cache_policy_id = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"

    response_headers_policy_id = var.response_headers_policy_id
  }

  dynamic "custom_error_response" {
    # Single-page-app routing: a deep link has no S3 object behind it, so both
    # 403 (OAC denies a missing key) and 404 must return index.html with a 200
    # and let the client router resolve the path.
    for_each = var.enable_spa_routing ? [403, 404] : []

    content {
      error_code            = custom_error_response.value
      response_code         = 200
      response_page_path    = "/index.html"
      error_caching_min_ttl = 0
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = var.geo_restriction_type
      locations        = var.geo_restriction_locations
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = var.acm_certificate_arn == null
    acm_certificate_arn            = var.acm_certificate_arn
    ssl_support_method             = var.acm_certificate_arn == null ? null : "sni-only"
    minimum_protocol_version       = var.acm_certificate_arn == null ? "TLSv1" : "TLSv1.2_2021"
  }

  dynamic "logging_config" {
    for_each = var.access_logs_bucket_domain == null ? [] : [var.access_logs_bucket_domain]

    content {
      bucket          = logging_config.value
      prefix          = "${var.name_prefix}/cloudfront/"
      include_cookies = false
    }
  }

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-cdn"
  })
}

data "aws_iam_policy_document" "frontend" {
  statement {
    sid    = "AllowCloudFrontRead"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.frontend.arn}/*"]

    # Scoped to this distribution specifically, so another account's
    # distribution cannot be pointed at this bucket.
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.frontend.arn]
    }
  }

  statement {
    sid    = "DenyUnencryptedTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:*"]
    resources = [aws_s3_bucket.frontend.arn, "${aws_s3_bucket.frontend.arn}/*"]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  policy = data.aws_iam_policy_document.frontend.json

  depends_on = [aws_s3_bucket_public_access_block.frontend]
}
