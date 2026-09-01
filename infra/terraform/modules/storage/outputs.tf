output "backup_bucket_name" {
  description = "Backup bucket name. Set BACKUP_S3_BUCKET to this."
  value       = aws_s3_bucket.backups.id
}

output "backup_bucket_arn" {
  description = "Backup bucket ARN, for the instance role's grants."
  value       = aws_s3_bucket.backups.arn
}

output "kms_key_arn" {
  description = "CMK protecting backups, secrets, and the data volume."
  value       = local.kms_key_arn
}

output "kms_key_id" {
  description = "Key id, for resources that take an id rather than an ARN."
  value       = var.create_kms_key ? aws_kms_key.main[0].key_id : null
}

output "data_volume_id" {
  description = "EBS volume holding the SQLite database, or null when not created."
  value       = var.create_data_volume ? aws_ebs_volume.data[0].id : null
}
