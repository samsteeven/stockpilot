output "url" {
  description = "Adresse publique de StockPilot (front et API)."
  value       = "https://${aws_cloudfront_distribution.main.domain_name}"
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.main.id
}

output "web_bucket" {
  value = aws_s3_bucket.web.bucket
}

output "cluster" {
  value = aws_ecs_cluster.main.name
}

output "migrate_task_definition" {
  value = aws_ecs_task_definition.migrate.arn
}

output "task_subnets" {
  value = join(",", aws_subnet.public[*].id)
}

output "task_security_group" {
  value = aws_security_group.tasks.id
}

output "db_instance" {
  value = aws_db_instance.main.identifier
}

output "cache_replication_group" {
  value = aws_elasticache_replication_group.main.id
}

output "app_image_tag" {
  description = "Version de l'application en service (retour arrière : redéployer une étiquette précédente)."
  value       = var.app_image_tag
}

output "log_groups" {
  value = { for k, g in aws_cloudwatch_log_group.app : k => g.name }
}

output "payment_webhook_secret_arn" {
  description = "Secret partagé avec le prestataire de paiement (lu par les démonstrations, jamais affiché)."
  value       = aws_secretsmanager_secret.app["payment-webhook-secret"].arn
}

output "db_subnet_group" {
  value = aws_db_subnet_group.main.name
}

output "db_security_group" {
  value = aws_security_group.db.id
}

output "owner_database_url_secret_arn" {
  value = aws_secretsmanager_secret.app["owner-database-url"].arn
}
