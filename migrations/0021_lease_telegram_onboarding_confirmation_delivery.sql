ALTER TABLE minutka_private.telegram_sessions
  ADD COLUMN onboarding_confirmation_claim_key text,
  ADD COLUMN onboarding_confirmation_claimed_at timestamptz;

ALTER TABLE minutka_private.telegram_sessions
  ADD CONSTRAINT telegram_onboarding_confirmation_claim_pair
  CHECK (
    (onboarding_confirmation_claim_key IS NULL) =
    (onboarding_confirmation_claimed_at IS NULL)
  );
