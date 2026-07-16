ALTER TABLE minutka_private.profiles
  ADD COLUMN preferred_name text,
  ADD COLUMN assistant_name text,
  ADD COLUMN address_form text,
  ADD COLUMN timezone text;

-- Preserve every existing profile. Legacy role remains useful context, while
-- deterministic defaults make the new operational fields immediately valid.
UPDATE minutka_private.profiles
SET preferred_name = COALESCE(NULLIF(btrim(role), ''), employee_id),
    assistant_name = 'Ассистент',
    address_form = 'informal',
    timezone = 'Etc/UTC';

ALTER TABLE minutka_private.profiles
  ALTER COLUMN preferred_name SET NOT NULL,
  ALTER COLUMN assistant_name SET NOT NULL,
  ALTER COLUMN address_form SET NOT NULL,
  ALTER COLUMN timezone SET NOT NULL,
  ADD CONSTRAINT profiles_address_form_check CHECK (address_form IN ('informal', 'formal')),
  ALTER COLUMN role DROP NOT NULL,
  ALTER COLUMN typical_tasks DROP NOT NULL,
  ALTER COLUMN ai_level DROP NOT NULL;

-- Drafts are temporary and cannot be translated safely from the old mandatory
-- questionnaire. Reset them instead of guessing personal names or timezones.
DELETE FROM minutka_private.onboarding_drafts;
ALTER TABLE minutka_private.onboarding_drafts
  DROP COLUMN role,
  DROP COLUMN typical_tasks,
  DROP COLUMN ai_level,
  ADD COLUMN preferred_name text,
  ADD COLUMN assistant_name text,
  ADD COLUMN address_form text CHECK (address_form IN ('informal', 'formal')),
  ADD COLUMN response_length text CHECK (response_length IN ('short', 'balanced', 'detailed')),
  ADD COLUMN timezone text,
  DROP CONSTRAINT onboarding_drafts_pending_field_check,
  ADD CONSTRAINT onboarding_drafts_pending_field_check CHECK (
    pending_field IN ('preferredName', 'assistantName', 'addressForm', 'persona', 'responseLength', 'timezone')
  );
