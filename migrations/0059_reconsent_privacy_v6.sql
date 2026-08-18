-- privacy-v6 discloses the full research corpus/trace contour and replaces
-- privacy-v5 before the first external pilot. Existing Telegram sessions must
-- explicitly accept the new immutable policy snapshot before dialogue resumes.
UPDATE minutka_private.telegram_sessions AS session
SET consent_accepted_at = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE session.consent_accepted_at IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM minutka_private.consents AS consent
    WHERE consent.employee_id = session.employee_id
      AND consent.privacy_version IS DISTINCT FROM 'privacy-v6'
  );
