output "us_region" {
  description = "Primary AWS region."
  value       = var.us_region
}

output "eu_region" {
  description = "Secondary / Replica AWS region."
  value       = var.eu_region
}

output "us_api_endpoint" {
  description = "Regional API Gateway endpoint URL for US."
  value       = module.backend_us.api_endpoint
}

output "eu_api_endpoint" {
  description = "Regional API Gateway endpoint URL for EU."
  value       = module.backend_eu.api_endpoint
}

output "us_alb_dns_name" {
  description = "Application Load Balancer DNS name for US."
  value       = module.backend_us.alb_dns_name
}

output "eu_alb_dns_name" {
  description = "Application Load Balancer DNS name for EU."
  value       = module.backend_eu.alb_dns_name
}

output "us_soroban_rpc_url" {
  description = "Synced Soroban RPC endpoint used by US stack."
  value       = module.backend_us.soroban_rpc_url
}

output "eu_soroban_rpc_url" {
  description = "Synced Soroban RPC endpoint used by EU stack."
  value       = module.backend_eu.soroban_rpc_url
}

output "us_backup_bucket" {
  description = "Primary US database backup and WAL S3 bucket."
  value       = module.backend_us.backup_bucket_name
}

output "eu_backup_bucket" {
  description = "Replica EU database backup and WAL S3 bucket."
  value       = module.backend_eu.backup_bucket_name
}

output "us_health_check_id" {
  description = "Route53 health check ID for US primary."
  value       = aws_route53_health_check.us_primary.id
}

output "eu_health_check_id" {
  description = "Route53 health check ID for EU secondary."
  value       = aws_route53_health_check.eu_secondary.id
}
