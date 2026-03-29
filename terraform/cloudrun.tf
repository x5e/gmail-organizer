# Cloud Run service + dedicated service account
#
# Gated behind var.deploy_app (default: false).
# On first apply, only infrastructure (VPC, DB, secrets, registry, bastion) is created.
# After pushing the Docker image and populating secret versions, set deploy_app = true.

resource "google_service_account" "cloudrun" {
  account_id   = "gmail-organizer-run"
  display_name = "Gmail Organizer Cloud Run"
}

resource "google_cloud_run_v2_service" "app" {
  count    = var.deploy_app ? 1 : 0
  name     = "gmail-organizer"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  lifecycle {
    precondition {
      condition     = var.domain != ""
      error_message = "var.domain is required when deploy_app = true (the app needs BASE_URL to start)."
    }
  }

  template {
    service_account = google_service_account.cloudrun.email

    scaling {
      min_instance_count = 0
      max_instance_count = var.cloudrun_max_instances
    }

    vpc_access {
      connector = google_vpc_access_connector.main.id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = var.cloudrun_image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      env {
        name  = "BASE_URL"
        value = "https://${var.domain}"
      }

      env {
        name  = "LOG_LEVEL"
        value = "info"
      }

      # Secrets mounted from Secret Manager
      env {
        name = "GOOGLE_CLIENT_ID"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.google_client_id.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "GOOGLE_CLIENT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.google_client_secret.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "TOKEN_ENCRYPTION_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.token_encryption_key.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url.secret_id
            version = "latest"
          }
        }
      }
    }
  }

  depends_on = [
    google_project_service.apis["run.googleapis.com"],
    google_secret_manager_secret_iam_member.cloudrun_secrets,
  ]
}

# Allow unauthenticated access (the app handles its own auth via bearer tokens)
resource "google_cloud_run_v2_service_iam_member" "public" {
  count    = var.deploy_app ? 1 : 0
  name     = google_cloud_run_v2_service.app[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Domain mapping (only created when deploying with a domain)
resource "google_cloud_run_domain_mapping" "custom" {
  count    = var.deploy_app && var.domain != "" ? 1 : 0
  name     = var.domain
  location = var.region

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_v2_service.app[0].name
  }
}
