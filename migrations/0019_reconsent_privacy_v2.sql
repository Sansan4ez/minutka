-- privacy-v2 materially changes the Personal Assistant disclosure.
-- minutka_private.consents is the current snapshot, so re-consent replaces the
-- privacy-v1 row. For the limited pilot, prior versions exist only in
-- consent_accepted audit events and follow their retention/deletion lifecycle;
-- runtime guards require an explicit privacy-v2 re-consent.
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
