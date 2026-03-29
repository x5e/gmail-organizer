variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region for all resources"
  type        = string
  default     = "us-east4"
}

variable "domain" {
  description = "Custom domain for Cloud Run (e.g. reversible.app). Set to empty string to skip domain mapping."
  type        = string
  default     = ""
}

variable "db_tier" {
  description = "Cloud SQL machine tier"
  type        = string
  default     = "db-custom-1-3840"
}

variable "db_name" {
  description = "PostgreSQL database name"
  type        = string
  default     = "gmail_organizer"
}

variable "db_user" {
  description = "PostgreSQL user name"
  type        = string
  default     = "app"
}

variable "cloudrun_image" {
  description = "Docker image to deploy to Cloud Run (full path including tag). Set after first push to Artifact Registry."
  type        = string
  default     = "us-east4-docker.pkg.dev/PROJECT/gmail-organizer/server:latest"
}

variable "cloudrun_max_instances" {
  description = "Maximum number of Cloud Run instances"
  type        = number
  default     = 10
}

variable "bastion_ssh_cidrs" {
  description = "CIDR ranges allowed to SSH into the bastion (e.g. your IP). Use [\"0.0.0.0/0\"] to allow all."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}
