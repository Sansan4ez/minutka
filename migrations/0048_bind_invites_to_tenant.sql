ALTER TABLE minutka_private.participants
  ADD COLUMN company_id text NOT NULL,
  ADD COLUMN group_id text NOT NULL,
  ADD COLUMN role_id text;

ALTER TABLE minutka_private.participants
  ADD CONSTRAINT participants_completed_role_check CHECK (status <> 'profile_completed' OR role_id IS NOT NULL),
  ADD CONSTRAINT participants_company_group_fk
    FOREIGN KEY (company_id, group_id)
    REFERENCES minutka_reference.training_groups(company_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT participants_company_role_fk
    FOREIGN KEY (company_id, role_id)
    REFERENCES minutka_reference.roles(company_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT participants_employee_role_unique UNIQUE (employee_id, role_id);

ALTER TABLE minutka_private.profiles
  ADD COLUMN role_id text NOT NULL,
  ADD CONSTRAINT profiles_employee_role_fk
    FOREIGN KEY (employee_id, role_id)
    REFERENCES minutka_private.participants(employee_id, role_id) ON DELETE RESTRICT;

ALTER TABLE minutka_private.onboarding_drafts
  ADD COLUMN role_id text,
  DROP CONSTRAINT onboarding_drafts_pending_field_check,
  ADD CONSTRAINT onboarding_drafts_pending_field_check CHECK (
    pending_field IN ('roleId', 'preferredName', 'assistantName', 'addressForm', 'persona', 'responseLength', 'timezone')
  );
