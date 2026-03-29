output "cloud_run_url" {
  description = "Cloud Run service URL"
  value       = google_cloud_run_v2_service.app.uri
}

output "artifact_registry" {
  description = "Docker image registry path (push images here)"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.main.repository_id}"
}

output "cloud_sql_connection_name" {
  description = "Cloud SQL instance connection name"
  value       = google_sql_database_instance.main.connection_name
}

output "cloud_sql_private_ip" {
  description = "Cloud SQL private IP address"
  value       = google_sql_database_instance.main.private_ip_address
}

output "database_url" {
  description = "DATABASE_URL to store in Secret Manager (contains password)"
  value       = "postgresql://${var.db_user}:${random_password.db_password.result}@${google_sql_database_instance.main.private_ip_address}/${var.db_name}"
  sensitive   = true
}

output "bastion_ip" {
  description = "Bastion VM public IP address"
  value       = google_compute_instance.bastion.network_interface[0].access_config[0].nat_ip
}

output "bastion_ssh_command" {
  description = "SSH command to connect to the bastion"
  value       = "gcloud compute ssh gmail-organizer-bastion --zone=${var.region}-b --project=${var.project_id}"
}

output "bastion_psql_command" {
  description = "psql command to run on the bastion (after SSH)"
  value       = "psql postgresql://${var.db_user}@${google_sql_database_instance.main.private_ip_address}/${var.db_name}"
}

output "domain_mapping_dns_records" {
  description = "DNS records to configure at your domain registrar (only shown when domain is set)"
  value       = var.domain != "" ? google_cloud_run_domain_mapping.custom[0].status[0].resource_records : []
}

output "docker_push_commands" {
  description = "Commands to build and push the Docker image"
  value       = <<-EOT
    # Authenticate Docker with Artifact Registry
    gcloud auth configure-docker ${var.region}-docker.pkg.dev

    # Build and push
    docker build -t ${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.main.repository_id}/server:latest .
    docker push ${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.main.repository_id}/server:latest
  EOT
}
