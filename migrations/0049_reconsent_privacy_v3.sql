-- privacy-v3 replaces the inherited Personal Assistant disclosure with the
-- Minutka consent boundary. Existing sessions must explicitly accept it.
UPDATE minutka_private.telegram_sessions AS session
SET consent_accepted_at = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE session.consent_accepted_at IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM minutka_private.consents AS consent
    WHERE consent.employee_id = session.employee_id
      AND consent.privacy_version IS DISTINCT FROM 'privacy-v3'
  );
