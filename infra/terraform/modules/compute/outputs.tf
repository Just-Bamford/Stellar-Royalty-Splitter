output "alb_dns_name" {
  description = "Load balancer DNS name — the API endpoint before a custom domain is pointed at it."
  value       = aws_lb.main.dns_name
}

output "alb_zone_id" {
  description = "Hosted zone id, for a Route 53 alias record."
  value       = aws_lb.main.zone_id
}

output "alb_arn" {
  description = "Load balancer ARN."
  value       = aws_lb.main.arn
}

output "alb_arn_suffix" {
  description = "ARN suffix, required by CloudWatch ALB metric dimensions."
  value       = aws_lb.main.arn_suffix
}

output "target_group_arn" {
  description = "Target group ARN."
  value       = aws_lb_target_group.app.arn
}

output "target_group_arn_suffix" {
  description = "Target group ARN suffix, for CloudWatch metric dimensions."
  value       = aws_lb_target_group.app.arn_suffix
}

output "autoscaling_group_name" {
  description = "Auto-scaling group name."
  value       = aws_autoscaling_group.app.name
}

output "launch_template_id" {
  description = "Launch template id."
  value       = aws_launch_template.app.id
}

output "api_base_url" {
  description = "Base URL for the API. Set FRONTEND_ORIGIN and the frontend API base to this until a custom domain exists."
  value       = var.certificate_arn == null ? "http://${aws_lb.main.dns_name}" : "https://${aws_lb.main.dns_name}"
}
