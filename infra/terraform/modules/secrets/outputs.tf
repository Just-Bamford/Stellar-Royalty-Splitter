output "signing_key_secret_arn" {
  description = "ARN of the signing key secret. Set AWS_SECRET_NAME to its name."
  value       = var.create_signing_key_secret ? aws_secretsmanager_secret.signing_key[0].arn : null
}

output "signing_key_secret_name" {
  description = "Name of the signing key secret, for AWS_SECRET_NAME."
  value       = var.create_signing_key_secret ? aws_secretsmanager_secret.signing_key[0].name : null
}

output "backup_encryption_key_secret_arn" {
  description = "ARN of the backup encryption passphrase secret."
  value       = var.create_backup_key_secret ? aws_secretsmanager_secret.backup_encryption_key[0].arn : null
}

output "admin_rotate_token_secret_arn" {
  description = "ARN of the admin rotate-key token secret."
  value       = var.create_admin_token_secret ? aws_secretsmanager_secret.admin_rotate_token[0].arn : null
}

output "all_secret_arns" {
  description = "Every secret ARN created here, for a single IAM grant covering the set."
  value = compact([
    var.create_signing_key_secret ? aws_secretsmanager_secret.signing_key[0].arn : "",
    var.create_backup_key_secret ? aws_secretsmanager_secret.backup_encryption_key[0].arn : "",
    var.create_admin_token_secret ? aws_secretsmanager_secret.admin_rotate_token[0].arn : "",
  ])
}
