output "bucket_name" {
  description = "Frontend bucket. Deploy with: aws s3 sync frontend/dist/ s3://<this>/ --delete"
  value       = aws_s3_bucket.frontend.id
}

output "bucket_arn" {
  description = "Frontend bucket ARN."
  value       = aws_s3_bucket.frontend.arn
}

output "distribution_id" {
  description = "CloudFront distribution id. Needed to invalidate /index.html after a deploy."
  value       = aws_cloudfront_distribution.frontend.id
}

output "distribution_domain_name" {
  description = "CloudFront domain name."
  value       = aws_cloudfront_distribution.frontend.domain_name
}

output "distribution_hosted_zone_id" {
  description = "CloudFront hosted zone id, for a Route 53 alias record."
  value       = aws_cloudfront_distribution.frontend.hosted_zone_id
}

output "frontend_url" {
  description = "Public URL of the frontend. Set FRONTEND_ORIGIN on the backend to this so CORS admits it."
  value       = length(var.domain_aliases) > 0 ? "https://${var.domain_aliases[0]}" : "https://${aws_cloudfront_distribution.frontend.domain_name}"
}
