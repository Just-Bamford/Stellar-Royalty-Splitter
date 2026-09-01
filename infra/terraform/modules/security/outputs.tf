output "alb_security_group_id" {
  description = "Security group for the load balancer."
  value       = aws_security_group.alb.id
}

output "app_security_group_id" {
  description = "Security group for the application instances."
  value       = aws_security_group.app.id
}

output "instance_profile_name" {
  description = "Instance profile to attach to the application instances."
  value       = aws_iam_instance_profile.app.name
}

output "instance_role_arn" {
  description = "ARN of the application role, for resource policies that need to name it."
  value       = aws_iam_role.app.arn
}

output "instance_role_name" {
  description = "Name of the application role."
  value       = aws_iam_role.app.name
}
