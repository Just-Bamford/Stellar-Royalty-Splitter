/**
 * Database cross-region replication configuration (#934).
 *
 * Implements primary-to-replica database synchronization between US (primary)
 * and EU (replica):
 *   1. S3 Cross-Region Replication (CRR): All SQLite snapshots, WAL journals,
 *      and automated backups written to the primary US S3 bucket are
 *      asynchronously replicated to the replica EU S3 bucket.
 *   2. EBS Volume Snapshot Replication (DLM): AWS Data Lifecycle Manager
 *      automatically takes periodic snapshots of the primary SQLite EBS data
 *      volume in us-east-1 and copies them cross-region to eu-west-1.
 *   3. EventBridge replication monitoring: Tracks replication health and
 *      ensures replica standby freshness meets RTO/RPO targets.
 */

# ── 1. S3 Cross-Region Replication (US -> EU) ────────────────────────────────

resource "aws_iam_role" "s3_replication" {
  name_prefix = "${var.name_prefix}-s3-crr-"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "s3.amazonaws.com"
      }
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_policy" "s3_replication" {
  name_prefix = "${var.name_prefix}-s3-crr-policy-"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetReplicationConfiguration",
          "s3:ListBucket"
        ]
        Resource = [module.backend_us.backup_bucket_arn]
      },
      {
        Effect = "Allow"
        Action = [
          "s3:GetObjectVersionForReplication",
          "s3:GetObjectVersionAcl",
          "s3:GetObjectVersionTagging"
        ]
        Resource = ["${module.backend_us.backup_bucket_arn}/*"]
      },
      {
        Effect = "Allow"
        Action = [
          "s3:ReplicateObject",
          "s3:ReplicateDelete",
          "s3:ReplicateTags",
          "s3:GetObjectVersionTagging"
        ]
        Resource = ["${module.backend_eu.backup_bucket_arn}/*"]
      },
      {
        Effect = "Allow"
        Action = [
          "kms:Decrypt"
        ]
        Resource = [module.backend_us.kms_key_arn]
      },
      {
        Effect = "Allow"
        Action = [
          "kms:Encrypt"
        ]
        Resource = [module.backend_eu.kms_key_arn]
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "s3_replication" {
  role       = aws_iam_role.s3_replication.name
  policy_arn = aws_iam_policy.s3_replication.arn
}

resource "aws_s3_bucket_replication_configuration" "database_replication" {
  role   = aws_iam_role.s3_replication.arn
  bucket = module.backend_us.backup_bucket_name

  rule {
    id     = "sqlite-backup-and-wal-replication"
    status = "Enabled"

    filter {}

    destination {
      bucket        = module.backend_eu.backup_bucket_arn
      storage_class = "STANDARD"

      encryption_configuration {
        replica_kms_key_id = module.backend_eu.kms_key_arn
      }

      metrics {
        status = "Enabled"
        event_threshold {
          minutes = 15
        }
      }

      replication_time {
        status = "Enabled"
        time {
          minutes = 15
        }
      }
    }

    source_selection_criteria {
      sse_kms_encrypted_objects {
        status = "Enabled"
      }
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.s3_replication
  ]
}

# ── 2. EBS Volume Snapshot Cross-Region Copy (US -> EU) ──────────────────────

resource "aws_iam_role" "dlm_lifecycle" {
  name_prefix = "${var.name_prefix}-dlm-"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "dlm.amazonaws.com"
      }
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "dlm_lifecycle" {
  role       = aws_iam_role.dlm_lifecycle.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_dlm_lifecycle_policy" "database_snapshot_replication" {
  description        = "Cross-region EBS snapshot replication of SQLite data volume from US to EU"
  execution_role_arn = aws_iam_role.dlm_lifecycle.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]

    target_tags = {
      Role = "database-primary"
    }

    schedule {
      name = "hourly-snapshots-with-cross-region-copy"

      create_rule {
        interval      = 1
        interval_unit = "HOURS"
        times         = ["00:00"]
      }

      retain_rule {
        count = 24
      }

      copy_tags = true

      cross_region_copy_rule {
        target    = var.eu_region
        encrypted = true
        cmk_arn   = module.backend_eu.kms_key_arn

        retain_rule {
          interval      = 7
          interval_unit = "DAYS"
        }
      }
    }
  }

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-ebs-replication"
  })

  depends_on = [aws_iam_role_policy_attachment.dlm_lifecycle]
}

# ── 3. Replication Health Monitoring & Telemetry ──────────────────────────────

resource "aws_cloudwatch_event_rule" "replication_health" {
  name_prefix         = "${var.name_prefix}-rep-health-"
  description         = "Periodic check of database cross-region replication lag"
  schedule_expression = "rate(15 minutes)"

  tags = local.common_tags
}
