# StockPilot sur AWS : une démonstration réelle, dimensionnée au plus juste, détruite après usage.
# Coût et choix : docs/architecture/adr/016-deploiement-aws.md.

terraform {
  required_version = "~> 1.16.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.69.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7.0"
    }
  }

  # Compartiment créé par l'amorçage (infrastructure/aws/bootstrap.yml) ; nom passé à `terraform init`.
  # Verrou natif S3 (pas de table DynamoDB).
  backend "s3" {
    key          = "stockpilot/demo.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Projet        = "stockpilot"
      Environnement = var.environment
      GerePar       = "terraform"
      Depot         = "github.com/samsteeven/stockpilot"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name = "stockpilot-${var.environment}"
  azs  = slice(data.aws_availability_zones.available.names, 0, 2)
  ecr  = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.region}.amazonaws.com"
  images = {
    runtime = "${local.ecr}/stockpilot:${var.app_image_tag}"
    migrate = "${local.ecr}/stockpilot-migrate:${var.migrate_image_tag}"
  }
}
