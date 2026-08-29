ALTER TABLE minutka_private.activity_revisions
  DROP CONSTRAINT activity_revisions_system_check;

ALTER TABLE minutka_private.activity_revisions
  ADD CONSTRAINT activity_revisions_system_check CHECK (
    system IN (
      'bitrix24', 'one_c', 'spreadsheets', 'email', 'messengers', 'crm', 'task_tracker',
      'telephony', 'tender_platform', 'logistics_system', 'learning_platform',
      'paper_or_verbal', 'other'
    )
  );
