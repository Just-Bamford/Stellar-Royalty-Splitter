output "api_url" {
  description = "Base URL of the API."
  value       = module.compute.api_base_url
}

output "frontend_url" {
  description = "Public URL of the frontend."
  value       = module.frontend.frontend_url
}

output "frontend_bucket" {
  description = "Deploy the frontend with: aws s3 sync frontend/dist/ s3://<this>/ --delete"
  value       = module.frontend.bucket_name
}

output "frontend_distribution_id" {
  description = "Invalidate after a deploy: aws cloudfront create-invalidation --distribution-id <this> --paths '/index.html'"
  value       = module.frontend.distribution_id
}

output "backup_bucket" {
  description = "Set BACKUP_S3_BUCKET to this when running scripts/automated-backup.sh."
  value       = module.storage.backup_bucket_name
}

output "data_volume_id" {
  description = "EBS volume holding the SQLite database. Needed by the disaster-recovery tooling."
  value       = module.storage.data_volume_id
}

output "signing_key_secret_name" {
  description = "Set AWS_SECRET_NAME to this. The value must be written out-of-band — see infra/terraform/README.md."
  value       = module.secrets.signing_key_secret_name
}

output "log_group_name" {
  description = "CloudWatch log group carrying application and bootstrap logs."
  value       = module.monitoring.log_group_name
}

output "alert_topic_arn" {
  description = "SNS topic carrying alarm notifications."
  value       = module.monitoring.alert_topic_arn
}

output "autoscaling_group_name" {
  description = "ASG name, for forcing an instance replacement during a recovery exercise."
  value       = module.compute.autoscaling_group_name
}

output "vpc_id" {
  description = "VPC identifier."
  value       = module.network.vpc_id
}

output "nat_gateway_ips" {
  description = "Source addresses for outbound traffic — what an external allowlist needs."
  value       = module.network.nat_gateway_ips
}

# ── Inputs for the operations stack in infra/terraform/*.tf (#935–#938) ─────

output "listener_arn" {
  description = "Serving ALB listener, for the canary weighted-routing rule."
  value       = module.compute.listener_arn
}

output "target_group_arn" {
  description = "Stable target group ARN."
  value       = module.compute.target_group_arn
}

output "alb_arn_suffix" {
  description = "ALB ARN suffix, for CloudWatch metric dimensions."
  value       = module.compute.alb_arn_suffix
}

output "alb_security_group_id" {
  description = "Load balancer security group."
  value       = module.security.alb_security_group_id
}

output "app_security_group_id" {
  description = "Application instance security group."
  value       = module.security.app_security_group_id
}

output "instance_role_name" {
  description = "Instance IAM role, for granting the audit-archive upload permission."
  value       = module.security.instance_role_name
}

output "kms_key_arn" {
  description = "Environment CMK (null when SSE-S3 is used)."
  value       = module.storage.kms_key_arn
}
