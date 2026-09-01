variable "name_prefix" {
  description = "Prefix applied to every resource name."
  type        = string
}

variable "bucket_name" {
  description = "Bucket holding the built frontend. Must be globally unique."
  type        = string
}

variable "force_destroy" {
  description = "Allow a terraform destroy to remove a non-empty bucket. Safe here — the contents are build output, reproducible from source."
  type        = bool
  default     = true
}

variable "enable_versioning" {
  description = "Keep previous object versions so a bad frontend deploy can be rolled back without rebuilding."
  type        = bool
  default     = true
}

variable "enable_spa_routing" {
  description = "Rewrite 403 and 404 to /index.html with a 200 so client-side routes resolve. Disable only when serving something other than a single-page app."
  type        = bool
  default     = true
}

variable "price_class" {
  description = "CloudFront price class. PriceClass_100 covers North America and Europe at the lowest cost."
  type        = string
  default     = "PriceClass_100"

  validation {
    condition     = contains(["PriceClass_All", "PriceClass_200", "PriceClass_100"], var.price_class)
    error_message = "price_class must be one of PriceClass_All, PriceClass_200, or PriceClass_100."
  }
}

variable "domain_aliases" {
  description = "Custom domains served by the distribution. Requires acm_certificate_arn."
  type        = list(string)
  default     = []
}

variable "acm_certificate_arn" {
  description = "ACM certificate for the custom domains. Must be issued in us-east-1 — CloudFront reads certificates only from that region. Null uses the default CloudFront certificate."
  type        = string
  default     = null
}

variable "response_headers_policy_id" {
  description = "CloudFront response headers policy, for security headers such as HSTS and CSP. Null applies none."
  type        = string
  default     = null
}

variable "web_acl_arn" {
  description = "WAFv2 web ACL ARN. Must be scoped CLOUDFRONT and created in us-east-1. Null disables WAF."
  type        = string
  default     = null
}

variable "geo_restriction_type" {
  description = "Geographic restriction mode: none, whitelist, or blacklist."
  type        = string
  default     = "none"

  validation {
    condition     = contains(["none", "whitelist", "blacklist"], var.geo_restriction_type)
    error_message = "geo_restriction_type must be none, whitelist, or blacklist."
  }
}

variable "geo_restriction_locations" {
  description = "Country codes for the geographic restriction. Empty when the type is none."
  type        = list(string)
  default     = []
}

variable "access_logs_bucket_domain" {
  description = "Bucket domain name for CloudFront access logs, e.g. logs.s3.amazonaws.com. Null disables logging."
  type        = string
  default     = null
}

variable "tags" {
  description = "Tags applied to every resource in this module."
  type        = map(string)
  default     = {}
}
