# Calcul : ECS Fargate. L'API (2 instances) derrière le répartiteur, le worker (1 instance), et une tâche de
# migration lancée par le déploiement avant chaque mise à jour des services.

resource "aws_ecs_cluster" "main" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "disabled" # ≈ 10 $/mois ; journaux et métriques du répartiteur suffisent ici
  }
}

resource "aws_cloudwatch_log_group" "app" {
  for_each          = toset(["api", "worker", "migrate"])
  name              = "/${local.name}/${each.key}"
  retention_in_days = 14
}

# --- Rôles -----------------------------------------------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Rôle d'exécution : ce dont ECS a besoin pour démarrer une tâche (images, journaux, secrets de CE projet).
resource "aws_iam_role" "execution" {
  name               = "stockpilot-${var.environment}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  name = "secrets-du-projet"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [for s in aws_secretsmanager_secret.app : s.arn]
    }]
  })
}

# Rôle des tâches : l'application n'appelle aucun service AWS ; aucun droit.
resource "aws_iam_role" "task" {
  name               = "stockpilot-${var.environment}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

# --- Définitions de tâches -------------------------------------------------------------------------------------------

locals {
  redis_url = "rediss://${aws_elasticache_replication_group.main.primary_endpoint_address}:6379"
  log_config = { for k, g in aws_cloudwatch_log_group.app : k => {
    logDriver = "awslogs"
    options = {
      awslogs-group         = g.name
      awslogs-region        = var.region
      awslogs-stream-prefix = k
    }
  } }
  common_env = [
    { name = "NODE_ENV", value = "production" },
    { name = "REDIS_URL", value = local.redis_url },
    { name = "DATABASE_POOL_SIZE", value = "5" },
    { name = "RESERVATION_TTL_SECONDS", value = "900" },
  ]
  secret = { for k, s in aws_secretsmanager_secret.app : k => s.arn }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([{
    name                   = "api"
    image                  = local.images.runtime
    essential              = true
    readonlyRootFilesystem = true
    portMappings           = [{ containerPort = 3000, protocol = "tcp" }]
    environment = concat(local.common_env, [
      { name = "PORT", value = "3000" },
      { name = "METRICS_PORT", value = "9464" },
      { name = "COOKIE_SECURE", value = "true" },
      # CloudFront puis le répartiteur : deux proxys de confiance devant l'API.
      { name = "TRUST_PROXY_HOPS", value = "2" },
      { name = "LOG_LEVEL", value = var.api_log_level },
    ])
    secrets = [
      { name = "APP_DATABASE_URL", valueFrom = local.secret["app-database-url"] },
      { name = "JWT_SECRET", valueFrom = local.secret["jwt-secret"] },
      { name = "PAYMENT_WEBHOOK_SECRET", valueFrom = local.secret["payment-webhook-secret"] },
    ]
    logConfiguration = local.log_config["api"]
  }])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([{
    name                   = "worker"
    image                  = local.images.runtime
    essential              = true
    readonlyRootFilesystem = true
    command                = ["node", "worker/main.js"]
    environment = concat(local.common_env, [
      { name = "METRICS_PORT", value = "9465" },
      { name = "LOG_LEVEL", value = "info" },
      # Pas de relais SMTP dans la démonstration : les e-mails sont écrits dans les journaux (voir l'ADR-016).
      { name = "MAIL_FROM", value = "Atelier Nova <commandes@atelier-nova.example>" },
    ])
    secrets = [
      { name = "APP_DATABASE_URL", valueFrom = local.secret["app-database-url"] },
    ]
    logConfiguration = local.log_config["worker"]
  }])
}

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([{
    name      = "migrate"
    image     = local.images.migrate
    essential = true
    command = ["sh", "-c", join(" && ", compact([
      "node scripts/preparer-base.mjs",
      "npx prisma migrate deploy",
      var.seed_demo ? "npm run db:seed" : "",
    ]))]
    environment = [{ name = "NODE_ENV", value = "production" }]
    secrets = [
      { name = "DATABASE_URL", valueFrom = local.secret["owner-database-url"] },
      { name = "APP_DATABASE_PASSWORD", valueFrom = local.secret["app-database-password"] },
    ]
    logConfiguration = local.log_config["migrate"]
  }])
}

# --- Services --------------------------------------------------------------------------------------------------------

resource "aws_ecs_service" "api" {
  name                              = "api"
  cluster                           = aws_ecs_cluster.main.id
  task_definition                   = aws_ecs_task_definition.api.arn
  desired_count                     = var.api_desired_count
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 30
  wait_for_steady_state             = true

  # Une nouvelle version qui ne devient pas saine est retirée et la précédente remise en place, sans intervention.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3000
  }

  depends_on = [aws_lb_listener.http]
}

resource "aws_ecs_service" "worker" {
  name                  = "worker"
  cluster               = aws_ecs_cluster.main.id
  task_definition       = aws_ecs_task_definition.worker.arn
  desired_count         = var.worker_desired_count
  launch_type           = "FARGATE"
  wait_for_steady_state = true

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  # Un seul worker : l'ancien s'arrête quand le nouveau a démarré (les jobs sont repris par la file).
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = true
  }
}

# --- Répartiteur de charge -------------------------------------------------------------------------------------------

resource "random_password" "origin_header" {
  length  = 40
  special = false
}

# Répartiteur interne, dans les sous-réseaux privés : CloudFront l'atteint par une origine VPC, sans qu'il soit
# joignable depuis Internet.
resource "aws_lb" "main" {
  name                       = local.name
  load_balancer_type         = "application"
  internal                   = true
  subnets                    = aws_subnet.private[*].id
  security_groups            = [aws_security_group.alb.id]
  idle_timeout               = 30
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "api" {
  name                 = "${local.name}-api"
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.main.id
  deregistration_delay = 15

  # « Prêt » : la base répond. Une instance qui perd la base sort du répartiteur.
  health_check {
    path                = "/health/ready"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200"
  }
}

# HTTP : le trafic CloudFront → répartiteur passe par l'origine VPC, dans le réseau d'AWS ; HTTPS demanderait
# un domaine et son certificat (ADR-016).
#trivy:ignore:AWS-0054
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  # Par défaut : refusé. Seules les requêtes portant l'en-tête secret posé par CloudFront passent.
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Acces direct refuse"
      status_code  = "403"
    }
  }
}

resource "aws_lb_listener_rule" "from_cloudfront" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 10

  condition {
    http_header {
      http_header_name = "X-Origin-Verify"
      values           = [random_password.origin_header.result]
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}
