# Surveillance : alarmes CloudWatch envoyées par e-mail, erreurs repérées dans les journaux JSON, budget.
# (Les métriques Prometheus restent exposées sur les ports internes ; pas de Prometheus géré dans la
# démonstration, voir l'ADR-016.)

# Sujet non chiffré : CloudWatch ne peut pas publier vers un sujet chiffré par la clé gérée par AWS, et une clé
# dédiée coûterait plus que l'enjeu (des messages d'alarme, sans données).
#trivy:ignore:AWS-0095
resource "aws_sns_topic" "alerts" {
  name = "${local.name}-alertes"
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

locals {
  alb_dimensions = { LoadBalancer = aws_lb.main.arn_suffix }
  tg_dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
    TargetGroup  = aws_lb_target_group.api.arn_suffix
  }
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${local.name}-api-5xx"
  alarm_description   = "Plus de 10 réponses 5xx de l'API en 5 min : voir les journaux /${local.name}/api (niveau 50)."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = local.tg_dimensions
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "api_latency" {
  alarm_name          = "${local.name}-api-latence"
  alarm_description   = "p95 du temps de réponse de l'API au-dessus de 1 s pendant 10 min."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  dimensions          = local.tg_dimensions
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "api_unhealthy" {
  alarm_name          = "${local.name}-api-instances"
  alarm_description   = "Moins de ${var.api_desired_count} instances saines de l'API pendant 2 min."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HealthyHostCount"
  dimensions          = local.tg_dimensions
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 2
  threshold           = var.api_desired_count
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "db_cpu" {
  alarm_name          = "${local.name}-db-cpu"
  alarm_description   = "PostgreSQL au-dessus de 80 % de CPU pendant 10 min."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "db_storage" {
  alarm_name          = "${local.name}-db-stockage"
  alarm_description   = "Moins de 2 Go libres sur PostgreSQL."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 2 * 1024 * 1024 * 1024
  comparison_operator = "LessThanThreshold"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# Erreurs dans les journaux JSON (niveau pino ≥ 50) de l'API et du worker : un compteur, puis une alarme.
resource "aws_cloudwatch_log_metric_filter" "errors" {
  for_each       = toset(["api", "worker"])
  name           = "${local.name}-${each.key}-erreurs"
  log_group_name = aws_cloudwatch_log_group.app[each.key].name
  pattern        = "{ $.level >= 50 }"
  metric_transformation {
    name          = "ErreursJournal"
    namespace     = "StockPilot/${var.environment}"
    value         = "1"
    default_value = "0"
    dimensions    = { Service = "$.service" }
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_errors" {
  alarm_name          = "${local.name}-worker-erreurs"
  alarm_description   = "Plus de 5 erreurs dans les journaux du worker en 10 min (outbox, e-mails, base)."
  namespace           = "StockPilot/${var.environment}"
  metric_name         = "ErreursJournal"
  dimensions          = { Service = "worker" }
  statistic           = "Sum"
  period              = 600
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.errors]
}

# Budget du compte entier (un filtre par étiquette exigerait d'activer les étiquettes de répartition des coûts) :
# alertes à 50, 80 et 100 % du montant mensuel, sur les coûts réels et prévus.
resource "aws_budgets_budget" "monthly" {
  name         = "${local.name}-mensuel"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = [50, 80, 100]
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = [var.alert_email]
    }
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}
