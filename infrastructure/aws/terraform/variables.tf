variable "region" {
  description = "Région AWS (Paris par défaut)."
  type        = string
  default     = "eu-west-3"
}

variable "environment" {
  description = "Nom de l'environnement, dans les noms et les étiquettes."
  type        = string
  default     = "demo"
}

variable "app_image_tag" {
  description = "Étiquette (empreinte git) de l'image de l'API et du worker."
  type        = string
}

variable "migrate_image_tag" {
  description = "Étiquette de l'image de migration ; déployée avant l'application (migrations rétrocompatibles)."
  type        = string
}

variable "api_desired_count" {
  description = "Instances de l'API (2 : une panne d'instance ne coupe pas le service)."
  type        = number
  default     = 2
}

variable "worker_desired_count" {
  description = "Instances du worker."
  type        = number
  default     = 1
}

variable "alert_email" {
  description = "Adresse qui reçoit les alarmes et les alertes de budget (confirmation par e-mail d'AWS)."
  type        = string
}

variable "monthly_budget_usd" {
  description = "Budget mensuel ; alertes à 50, 80 et 100 %."
  type        = number
  default     = 20
}

variable "db_instance_class" {
  description = "Classe de l'instance PostgreSQL."
  type        = string
  default     = "db.t4g.micro"
}

variable "seed_demo" {
  description = "Charger les données de démonstration (Atelier Nova, comptes publics) à la migration."
  type        = bool
  default     = true
}

variable "api_log_level" {
  description = <<-EOT
    Niveau des journaux de l'API. Une valeur inconnue fait échouer le démarrage : c'est ainsi que le scénario
    « déploiement défectueux » simule une mauvaise configuration (docs/exploitation).
  EOT
  type        = string
  default     = "info"
}
