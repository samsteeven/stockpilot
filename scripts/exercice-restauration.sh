#!/usr/bin/env bash
# Exercice de restauration (docs/exploitation/restauration.md), lancé par le workflow « Exploitation AWS » :
#   1. état du stock de l'entreprise de démonstration ;
#   2. erreur humaine : toutes ses quantités mises à 0 (scripts/incident-stock.mjs casser) ;
#   3. restauration de la base, dans une instance à part, à l'instant juste avant l'erreur (PITR) ;
#   4. réparation ligne par ligne depuis la copie, tracée en mouvements d'ajustement ; la base en service n'est
#      jamais remplacée (les commandes passées depuis l'erreur sont conservées) ;
#   5. suppression de la copie. Chaque étape est chronométrée.
# Variables : CLUSTER SUBNETS SG MIGRATE DB DB_SUBNETS DB_SG (sorties Terraform), AWS_REGION.
set -euo pipefail

LOG=exercice-restauration.log
COPY="${DB}-restauration"
t0=$(date +%s)
log() { echo "$(date -u +%T) $*" | tee -a "$LOG"; }
elapsed() { echo "$(( $(date +%s) - $1 )) s"; }

# Lance la tâche de migration avec une autre commande (même image, mêmes secrets : rôle propriétaire).
run_task() {
  local command=$1 env_json=${2:-[]}
  local overrides
  overrides=$(jq -n --arg c "$command" --argjson e "$env_json" \
    '{containerOverrides: [{name: "migrate", command: ["sh", "-c", $c], environment: $e}]}')
  local task
  task=$(aws ecs run-task --cluster "$CLUSTER" --launch-type FARGATE --task-definition "$MIGRATE" \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=ENABLED}" \
    --overrides "$overrides" --query 'tasks[0].taskArn' --output text)
  aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$task"
  local group
  group=$(aws ecs describe-task-definition --task-definition "$MIGRATE" \
    --query 'taskDefinition.containerDefinitions[0].logConfiguration.options."awslogs-group"' --output text)
  aws logs get-log-events --log-group-name "$group" --log-stream-name "migrate/migrate/${task##*/}" \
    --query 'events[].message' --output text | tr '\t' '\n' | tee -a "$LOG"
  local code
  code=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task" --query 'tasks[0].containers[0].exitCode' --output text)
  test "$code" = "0"
}

log "1. État avant l'erreur"
run_task 'TARGET_URL="$DATABASE_URL" node scripts/incident-stock.mjs etat'

before=$(date -u +%Y-%m-%dT%H:%M:%SZ)
sleep 5
log "2. Erreur humaine : quantités mises à 0 (instant de restauration visé : $before)"
run_task 'TARGET_URL="$DATABASE_URL" node scripts/incident-stock.mjs casser'
incident=$(date +%s)

log "3. Attente que l'instant visé soit couvert par les journaux de transactions archivés"
until [[ "$(aws rds describe-db-instances --db-instance-identifier "$DB" --query 'DBInstances[0].LatestRestorableTime' --output text)" > "$before" ]]; do
  sleep 20
done
restore_start=$(date +%s)
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier "$DB" --target-db-instance-identifier "$COPY" --restore-time "$before" \
  --db-subnet-group-name "$DB_SUBNETS" --vpc-security-group-ids "$DB_SG" --db-parameter-group-name "$DB" \
  --db-instance-class db.t4g.micro --no-multi-az --no-publicly-accessible --no-deletion-protection > /dev/null
log "   Restauration lancée dans $COPY"
# Le serveur d'attente d'AWS abandonne au bout de 30 min : on boucle jusqu'à 60 min.
for _ in $(seq 120); do
  status=$(aws rds describe-db-instances --db-instance-identifier "$COPY" --query 'DBInstances[0].DBInstanceStatus' --output text)
  [ "$status" = available ] && break
  sleep 30
done
test "$status" = available
host=$(aws rds describe-db-instances --db-instance-identifier "$COPY" --query 'DBInstances[0].Endpoint.Address' --output text)
restore_time=$(elapsed "$restore_start")
log "   Copie disponible en $restore_time : $host"

log "4. Réparation depuis la copie"
repair_start=$(date +%s)
run_task 'SOURCE_URL=$(echo "$DATABASE_URL" | sed "s#@[^:/]*:#@${RESTORED_HOST}:#") TARGET_URL="$DATABASE_URL" node scripts/incident-stock.mjs reparer' \
  "[{\"name\":\"RESTORED_HOST\",\"value\":\"$host\"}]"
repair_time=$(elapsed "$repair_start")
total=$(elapsed "$incident")

log "5. Suppression de la copie"
aws rds delete-db-instance --db-instance-identifier "$COPY" --skip-final-snapshot --delete-automated-backups > /dev/null

{
  echo "### Restauration à un instant donné et réparation"
  echo "- Données perdues (RPO) : aucune ligne de stock ; instant restauré : $before, 5 s avant l'erreur"
  echo "- Restauration de la copie : **$restore_time** ; réparation : $repair_time"
  echo "- De l'erreur à la réparation (RTO de cet incident) : **$total**"
  echo "- Base en service jamais arrêtée ni remplacée ; copie supprimée"
  echo "- Durée totale de l'exercice : $(elapsed "$t0")"
} >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"
