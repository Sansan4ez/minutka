-- New onboarding asks for one communication-style preset instead of separate
-- assistant-name, address-form, persona and response-length steps. Persisted
-- profile columns stay unchanged; only temporary draft state is normalized.
UPDATE minutka_private.onboarding_drafts
SET pending_field = CASE
  WHEN role_id IS NULL THEN 'roleId'
  WHEN preferred_name IS NULL THEN 'preferredName'
  WHEN address_form IS NULL OR persona IS NULL THEN 'communicationStyle'
  WHEN timezone IS NULL THEN 'timezone'
  ELSE NULL
END,
status = CASE
  WHEN role_id IS NOT NULL
    AND preferred_name IS NOT NULL
    AND address_form IS NOT NULL
    AND persona IS NOT NULL
    AND timezone IS NOT NULL
  THEN 'awaiting_confirmation'
  ELSE 'collecting'
END,
updated_at = now();

ALTER TABLE minutka_private.onboarding_drafts
  DROP CONSTRAINT onboarding_drafts_pending_field_check,
  ADD CONSTRAINT onboarding_drafts_pending_field_check CHECK (
    pending_field IN ('roleId', 'preferredName', 'communicationStyle', 'timezone')
  );
