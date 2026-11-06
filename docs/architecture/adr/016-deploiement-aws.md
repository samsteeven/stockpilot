# ADR-016 : déploiement réel sur AWS, au plus juste, détruit après usage

**État** : acceptée (infrastructure écrite et vérifiée ; exécution sur AWS : voir [docs/exploitation](../../exploitation/README.md)).

## Contexte

Montrer que StockPilot tourne ailleurs que sur un poste : vraie base gérée, vraie file, plusieurs instances, déploiement sans coupure, pannes provoquées et restauration exercée. Sur le compte AWS personnel de l'auteur : chaque euro compte, et rien ne doit rester allumé sans raison.

## Options étudiées

- **Kubernetes (EKS)** : 73 $/mois pour le seul plan de contrôle, avant le premier conteneur. Hors de proportion.
- **Une machine virtuelle avec docker compose** : la moins chère, mais ni base gérée, ni sauvegardes à la seconde, ni remplacement automatique d'instance : rien de ce qu'on veut exercer.
- **ECS Fargate, RDS, ElastiCache, CloudFront** : services gérés, facturés à l'heure, détruits en une commande.

## Décision

```
Navigateur ──HTTPS──► CloudFront ─┬─► S3 (front Angular, privé, accès par OAC)
                                  └─► /api/* ─ origine VPC ─► ALB interne ─► ECS Fargate : API × 2
                                                                            ECS Fargate : worker × 1
                                    sous-réseaux privés : RDS PostgreSQL 18 · ElastiCache Valkey 8
```

- **Région Paris** (eu-west-3), deux zones de disponibilité.
- **Un seul domaine** (celui de CloudFront) pour le front et l'API : le cookie `SameSite=Strict` fonctionne, le front appelle `/api` en relatif. Le répartiteur est **interne** : CloudFront l'atteint par une origine VPC, et un en-tête secret est exigé en plus ; un accès direct reçoit 403.
- **Pas de passerelle NAT** (≈ 35 $/mois) : les tâches ont une adresse publique pour sortir (ECR, Secrets Manager, CloudWatch), aucune entrée hors du répartiteur. Base et Valkey sont dans des sous-réseaux privés sans route vers Internet.
- **Images** construites dans la CI, étiquetées par l'empreinte git, **immuables** dans ECR, analysées (Trivy, critiques bloquantes), avec SBOM et attestation de provenance. Image de base épinglée par empreinte, utilisateur non root, système de fichiers en lecture seule.
- **Secrets** générés par Terraform, rangés dans Secrets Manager, injectés au démarrage des tâches. Ils sont aussi dans l'état Terraform, chiffré, dans un compartiment privé réservé au rôle de déploiement.
- **Déploiement** depuis GitHub Actions par **OIDC** (aucune clé AWS stockée), dans un environnement GitHub à approbation obligatoire. Ordre : images → migrations (application inchangée) → application → front → vérification par l'adresse publique. Les migrations sont **rétrocompatibles** (on ajoute avant de retirer) : l'ancienne version tourne sur le nouveau schéma, le retour arrière ne touche pas la base.
- **Sécurité des déploiements** : déploiement progressif (100 % → 200 %), disjoncteur ECS avec **retour automatique** si la nouvelle version ne devient pas saine.
- **Sauvegardes** RDS quotidiennes et **restauration à la seconde près** sur 7 jours, exercée.
- **Surveillance** : journaux JSON dans CloudWatch, alarmes (5xx, latence p95, instances saines, CPU et stockage de la base, erreurs du worker relevées dans les journaux) envoyées par e-mail, budget mensuel avec alertes. Pas de Prometheus géré (coût) : les métriques restent exposées sur les ports internes.

## Coût

Estimation pour la région Paris, hors offre gratuite, en laissant tout allumé :

| Poste                                           | Par heure    | Par mois (730 h) |
| ----------------------------------------------- | ------------ | ---------------- |
| Répartiteur (ALB)                               | 0,030 $      | 22 $             |
| Fargate : API × 2 et worker (0,25 vCPU, 0,5 Go) | 0,043 $      | 31 $             |
| RDS db.t4g.micro et 20 Go gp3                   | 0,022 $      | 16 $             |
| ElastiCache cache.t4g.micro                     | 0,019 $      | 14 $             |
| Adresses IPv4 publiques des tâches (× 3)        | 0,015 $      | 11 $             |
| Secrets Manager, CloudWatch, ECR, CloudFront    | ≈ 0,005 $    | ≈ 4 $            |
| **Total**                                       | **≈ 0,13 $** | **≈ 98 $**       |

**Usage prévu** : déployer, exécuter les scénarios d'exploitation, consigner les résultats, puis **détruire** (workflow « Exploitation AWS », scénario `detruire`). Une journée complète ≈ 3 à 5 $. Le budget alerte à 50, 80 et 100 % de 20 $ par mois.

## Conséquences et limites assumées

- **TLS vers la base sans vérification du certificat** (chiffré, mais un intermédiaire dans le VPC ne serait pas détecté) : embarquer l'autorité de certification de RDS dans l'image et passer en `verify-full` est la prochaine étape.
- **HTTP entre CloudFront et le répartiteur**, à l'intérieur du réseau d'AWS (origine VPC) : sans nom de domaine, pas de certificat pour le répartiteur.
- **Pas de WAF** (≈ 6 $/mois) ; la limite de débit des connexions est dans l'application. **Pas de points de terminaison privés** : sortie HTTPS ouverte depuis les tâches. Chaque exception est écrite à côté de la ressource et acceptée explicitement par l'analyse Trivy.
- **Une seule instance** de base et de Valkey, sans réplique : une panne de zone coupe le service jusqu'au remplacement. Valkey sans persistance : un redémarrage perd les jobs différés (le balayage de la base les rattrape, ADR-006) et les événements publiés mais pas encore traités (fenêtre de l'ordre de la seconde ; une réconciliation périodique « commande confirmée sans expédition » la fermerait).
- **E-mails** : pas de relais SMTP dans la démonstration (SES exige un domaine vérifié) ; le worker écrit les messages dans ses journaux.
- **Données de démonstration publiques** (comptes Atelier Nova) chargées à la migration : c'est une vitrine, pas une production.
