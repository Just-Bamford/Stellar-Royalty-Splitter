/**
 * Grafana dashboard provisioning (#935, #936).
 *
 * Every JSON file in monitoring/grafana-dashboards/ — plus the existing
 * operations dashboard in monitoring/grafana/ — is provisioned into one
 * folder, so a dashboard change is a reviewed pull request rather than an
 * edit in the Grafana UI that nobody can reproduce.
 *
 * Prometheus and Grafana themselves are assumed to exist (out of scope). The
 * dashboards select their data source through a `datasource` template
 * variable, so they work against whichever Prometheus data source the Grafana
 * instance already has.
 *
 * Retention: the dashboards' 30-day views need Prometheus to keep 30 days of
 * samples — `--storage.tsdb.retention.time=30d` (see monitoring/OPERATIONS.md).
 * Real-time: dashboards refresh every 60 seconds; Prometheus scrapes every 15s.
 */

variable "enable_grafana_dashboards" {
  description = "Provision the dashboards into Grafana. Requires grafana_url and grafana_auth (or GRAFANA_URL / GRAFANA_AUTH)."
  type        = bool
  default     = false
}

variable "grafana_url" {
  description = "Grafana base URL."
  type        = string
  default     = null
}

variable "grafana_auth" {
  description = "Grafana service-account token."
  type        = string
  default     = null
  sensitive   = true
}

variable "grafana_folder_title" {
  description = "Folder the dashboards are provisioned into."
  type        = string
  default     = "Stellar Royalty Splitter"
}

locals {
  dashboards_dir = "${path.module}/../../monitoring/grafana-dashboards"

  dashboard_files = var.enable_grafana_dashboards ? merge(
    { for f in fileset(local.dashboards_dir, "*.json") : trimsuffix(f, ".json") => "${local.dashboards_dir}/${f}" },
    { "royalty-splitter-operations" = "${path.module}/../../monitoring/grafana/royalty-splitter-dashboard.json" },
  ) : {}
}

resource "grafana_folder" "royalty_splitter" {
  count = var.enable_grafana_dashboards ? 1 : 0

  title = var.grafana_folder_title
}

resource "grafana_dashboard" "royalty_splitter" {
  for_each = local.dashboard_files

  folder      = grafana_folder.royalty_splitter[0].uid
  config_json = file(each.value)
  overwrite   = true
  message     = "Provisioned by infra/terraform/grafana.tf"
}

output "grafana_dashboard_urls" {
  description = "Provisioned dashboards."
  value       = { for k, d in grafana_dashboard.royalty_splitter : k => d.url }
}
