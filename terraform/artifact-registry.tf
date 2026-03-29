# Artifact Registry — Docker image repository

resource "google_artifact_registry_repository" "main" {
  location      = var.region
  repository_id = "gmail-organizer"
  format        = "DOCKER"
  description   = "Gmail Organizer MCP server images"

  depends_on = [google_project_service.apis["artifactregistry.googleapis.com"]]
}
