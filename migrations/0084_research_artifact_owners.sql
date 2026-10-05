-- Private research artifacts use a company/group-derived owner namespace, not a fake participant.
-- Keep ordinary employee ownership/cascading deletion through explicit triggers.
ALTER TABLE minutka_private.artifacts DROP CONSTRAINT artifacts_owner_fk;
ALTER TABLE minutka_private.artifact_contents DROP CONSTRAINT artifact_contents_owner_fk;

CREATE FUNCTION minutka_private.validate_artifact_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id !~ '^research-recommendations-[a-f0-9]{64}$'
     AND NOT EXISTS (SELECT 1 FROM minutka_private.participants WHERE employee_id=NEW.user_id) THEN
    RAISE EXCEPTION 'artifact owner not found' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER artifact_contents_validate_owner BEFORE INSERT OR UPDATE OF user_id ON minutka_private.artifact_contents
  FOR EACH ROW EXECUTE FUNCTION minutka_private.validate_artifact_owner();
CREATE TRIGGER artifacts_validate_owner BEFORE INSERT OR UPDATE OF user_id ON minutka_private.artifacts
  FOR EACH ROW EXECUTE FUNCTION minutka_private.validate_artifact_owner();

CREATE FUNCTION minutka_private.delete_employee_artifacts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM minutka_private.artifacts WHERE user_id=OLD.employee_id;
  DELETE FROM minutka_private.artifact_contents WHERE user_id=OLD.employee_id;
  RETURN OLD;
END;
$$;
CREATE TRIGGER participants_delete_artifacts BEFORE DELETE ON minutka_private.participants
  FOR EACH ROW EXECUTE FUNCTION minutka_private.delete_employee_artifacts();
