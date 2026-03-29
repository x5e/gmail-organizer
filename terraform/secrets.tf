# Secret Manager secrets — values are populated manually after terraform apply,
# or via `gcloud secrets versions add`.

resource "google_secret_manager_secret" "google_client_id" {
  secret_id = "gmail-organizer-google-client-id"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis["secretmanager.googleapis.com"]]
}

resource "google_secret_manager_secret" "google_client_secret" {
  secret_id = "gmail-organizer-google-client-secret"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis["secretmanager.googleapis.com"]]
}

resource "google_secret_manager_secret" "token_encryption_key" {
  secret_id = "gmail-organizer-token-encryption-key"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis["secretmanager.googleapis.com"]]
}

resource "google_secret_manager_secret" "database_url" {
  secret_id = "gmail-organizer-database-url"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis["secretmanager.googleapis.com"]]
}

# Grant Cloud Run service account access to read all secrets
locals {
  secrets = [
    google_secret_manager_secret.google_client_id.secret_id,
    google_secret_manager_secret.google_client_secret.secret_id,
    google_secret_manager_secret.token_encryption_key.secret_id,
    google_secret_manager_secret.database_url.secret_id,
  ]
}

resource "google_secret_manager_secret_iam_member" "cloudrun_secrets" {
  for_each  = toset(local.secrets)
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.cloudrun.email}"
}
