-- privacy-v2 materially changes the Personal Assistant disclosure. Existing
-- privacy-v1 acceptance remains as history in the consent row but is not
-- current; runtime guards require an explicit privacy-v2 re-consent.
UPDATE minutka_private.telegram_sessions AS session
SET consent_accepted_at = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE session.consent_accepted_at IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM minutka_private.consents AS consent
    WHERE consent.employee_id = session.employee_id
      AND consent.privacy_version IS DISTINCT FROM 'privacy-v2'
  );
