# Bastion VM — small instance in the VPC for direct psql/pg_dump access to Cloud SQL

# Auto-detect the public IP of whoever is running terraform
data "http" "my_ip" {
  url = "https://api.ipify.org"
}

resource "google_compute_instance" "bastion" {
  name         = "gmail-organizer-bastion"
  machine_type = "e2-micro"
  zone         = "${var.region}-b"

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
      size  = 10
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.main.id

    access_config {
      # Ephemeral public IP for SSH access
    }
  }

  metadata_startup_script = <<-EOF
    #!/bin/bash
    apt-get update -qq
    apt-get install -y -qq postgresql-client
  EOF

  tags = ["bastion"]

  service_account {
    scopes = ["cloud-platform"]
  }

  depends_on = [google_project_service.apis["compute.googleapis.com"]]
}

# Allow SSH to bastion only from the IP running terraform
resource "google_compute_firewall" "bastion_ssh" {
  name    = "gmail-organizer-bastion-ssh"
  network = google_compute_network.main.name

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = ["${chomp(data.http.my_ip.response_body)}/32"]
  target_tags   = ["bastion"]
}
