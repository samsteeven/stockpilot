# Données : PostgreSQL (RDS) et Valkey (ElastiCache), dans les sous-réseaux privés ; secrets dans Secrets Manager.

# --- Secrets ---------------------------------------------------------------------------------------------------------
# Générés par Terraform : ils figurent dans l'état, chiffré dans un compartiment privé (voir l'ADR-016). Les tâches
# les reçoivent de Secrets Manager au démarrage ; ils n'apparaissent ni dans les définitions de tâches ni dans les
# journaux.

resource "random_password" "db_owner" {
  length  = 32
  special = false
}

resource "random_password" "db_app" {
  length  = 32
  special = false
}

resource "random_password" "jwt" {
  length  = 64
  special = false
}

resource "random_password" "payment_webhook" {
  length  = 48
  special = false
}

locals {
  db_host = aws_db_instance.main.address
  # TLS imposé par RDS ; le certificat n'est pas encore vérifié (voir l'ADR-016). Deux dialectes : celui de
  # Prisma pour les migrations (sslaccept), celui de pg pour l'application (no-verify).
  owner_url = "postgresql://stockpilot:${random_password.db_owner.result}@${local.db_host}:5432/stockpilot?sslmode=require&sslaccept=accept_invalid_certs"
  app_url   = "postgresql://stockpilot_app:${random_password.db_app.result}@${local.db_host}:5432/stockpilot?sslmode=no-verify"
  secrets = {
    "owner-database-url"     = local.owner_url
    "app-database-url"       = local.app_url
    "app-database-password"  = random_password.db_app.result
    "jwt-secret"             = random_password.jwt.result
    "payment-webhook-secret" = random_password.payment_webhook.result
  }
}

resource "aws_secretsmanager_secret" "app" {
  for_each                = local.secrets
  name                    = "${local.name}/${each.key}"
  recovery_window_in_days = 0 # environnement de démonstration : suppression immédiate à la destruction
}

resource "aws_secretsmanager_secret_version" "app" {
  for_each      = local.secrets
  secret_id     = aws_secretsmanager_secret.app[each.key].id
  secret_string = each.value
}

# --- PostgreSQL ------------------------------------------------------------------------------------------------------

resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_parameter_group" "main" {
  name   = local.name
  family = "postgres18"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  # Requêtes lentes dans les journaux (plus de 500 ms).
  parameter {
    name  = "log_min_duration_statement"
    value = "500"
  }
}

resource "aws_db_instance" "main" {
  identifier     = local.name
  engine         = "postgres"
  engine_version = "18"
  instance_class = var.db_instance_class

  db_name  = "stockpilot"
  username = "stockpilot"
  password = random_password.db_owner.result

  allocated_storage     = 20
  max_allocated_storage = 50
  storage_type          = "gp3"
  storage_encrypted     = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  parameter_group_name   = aws_db_parameter_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false
  multi_az               = false

  # Sauvegardes quotidiennes et restauration à la seconde près sur 7 jours (exercée : docs/exploitation).
  backup_retention_period  = 7
  backup_window            = "02:00-02:30"
  maintenance_window       = "sun:03:00-sun:03:30"
  copy_tags_to_snapshot    = true
  delete_automated_backups = true

  auto_minor_version_upgrade = true
  apply_immediately          = true
  # Démonstration : destruction sans instantané final ni protection. En production : l'inverse.
  deletion_protection = false
  skip_final_snapshot = true
}

# --- Valkey (compatible Redis) ---------------------------------------------------------------------------------------

resource "aws_elasticache_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_elasticache_parameter_group" "main" {
  name   = local.name
  family = "valkey8"

  # BullMQ exige qu'aucune clé ne soit évincée quand la mémoire est pleine.
  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = local.name
  description          = "Files BullMQ de StockPilot"
  engine               = "valkey"
  engine_version       = "8.0"
  node_type            = "cache.t4g.micro"
  num_cache_clusters   = 1
  port                 = 6379

  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [aws_security_group.cache.id]
  parameter_group_name = aws_elasticache_parameter_group.main.name

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  automatic_failover_enabled = false
  apply_immediately          = true
}
