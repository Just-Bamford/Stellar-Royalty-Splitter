output "vpc_id" {
  description = "ID of the regional VPC."
  value       = aws_vpc.main.id
}

output "public_subnet_ids" {
  description = "IDs of the public subnets in this region."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "IDs of the private subnets in this region."
  value       = aws_subnet.private[*].id
}

output "alb_dns_name" {
  description = "Public DNS name of the regional Application Load Balancer."
  value       = aws_lb.main.dns_name
}

output "alb_zone_id" {
  description = "Canonical hosted zone ID of the regional ALB (for Route53 alias records)."
  value       = aws_lb.main.zone_id
}

output "alb_arn" {
  description = "ARN of the regional ALB."
  value       = aws_lb.main.arn
}

output "target_group_arn" {
  description = "ARN of the target group."
  value       = aws_lb_target_group.app.arn
}

output "api_endpoint" {
  description = "Regional API Gateway endpoint URL."
  value       = aws_apigatewayv2_api.regional.api_endpoint
}

output "api_gateway_id" {
  description = "ID of the regional HTTP API Gateway."
  value       = aws_apigatewayv2_api.regional.id
}

output "backup_bucket_name" {
  description = "Regional S3 backup bucket name."
  value       = aws_s3_bucket.backups.id
}

output "backup_bucket_arn" {
  description = "Regional S3 backup bucket ARN."
  value       = aws_s3_bucket.backups.arn
}

output "data_volume_id" {
  description = "ID of the EBS data volume holding the regional database."
  value       = aws_ebs_volume.data.id
}

output "kms_key_arn" {
  description = "ARN of the regional KMS encryption key."
  value       = aws_kms_key.main.arn
}

output "soroban_rpc_url" {
  description = "Configured Soroban RPC endpoint for this region."
  value       = var.soroban_rpc_url
}

output "horizon_url" {
  description = "Configured Stellar Horizon endpoint for this region."
  value       = var.horizon_url
}

output "health_check_url" {
  description = "HTTP health check URL for this region."
  value       = "http://${aws_lb.main.dns_name}/health"
}
