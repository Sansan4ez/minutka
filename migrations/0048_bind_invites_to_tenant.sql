ALTER TABLE minutka_private.participants
  ADD COLUMN company_id text,
  ADD COLUMN group_id text,
  ADD COLUMN role_id text;

-- Rows created before tenant-bound invites are kept for migration safety. New
-- invites always set company/group, and onboarding later selects the role.
ALTER TABLE minutka_private.participants
  ADD CONSTRAINT participants_tenant_pair_check CHECK ((company_id IS NULL) = (group_id IS NULL)),
  ADD CONSTRAINT participants_company_group_fk
    FOREIGN KEY (company_id, group_id)
    REFERENCES minutka_reference.training_groups(company_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT participants_company_role_fk
    FOREIGN KEY (company_id, role_id)
    REFERENCES minutka_reference.roles(company_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT participants_employee_role_unique UNIQUE (employee_id, role_id);

ALTER TABLE minutka_private.profiles
  ADD COLUMN role_id text,
  ADD CONSTRAINT profiles_employee_role_fk
    FOREIGN KEY (employee_id, role_id)
    REFERENCES minutka_private.participants(employee_id, role_id) ON DELETE RESTRICT;

ALTER TABLE minutka_private.onboarding_drafts
  ADD COLUMN role_id text,
  DROP CONSTRAINT onboarding_drafts_pending_field_check,
  ADD CONSTRAINT onboarding_drafts_pending_field_check CHECK (
    pending_field IN ('roleId', 'preferredName', 'assistantName', 'addressForm', 'persona', 'responseLength', 'timezone')
  );
