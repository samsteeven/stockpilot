-- Observabilité : l'application ne lit pas l'outbox (droit d'insertion seulement). Cette fonction n'en révèle que
-- le volume en attente et l'âge du plus ancien événement, pour les métriques et les alertes.
CREATE FUNCTION "outbox_backlog"()
  RETURNS TABLE ("pending" bigint, "oldest_age_seconds" double precision)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*), COALESCE(EXTRACT(EPOCH FROM now() - min("occurred_at")), 0)::double precision
  FROM "outbox_events" WHERE "published_at" IS NULL
$$;
REVOKE ALL ON FUNCTION "outbox_backlog"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "outbox_backlog"() TO stockpilot_runtime;
