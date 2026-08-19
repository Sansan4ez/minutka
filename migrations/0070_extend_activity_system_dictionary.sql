-- The closed system dictionary gains the generic values the first pilot cohort
-- needs: call-center telephony, tender platforms, logistics/TMS/WMS systems and
-- the learning platform used by the organizer test group. Values stay generic:
-- company brand and internal names are mapped to them before collection starts.
ALTER TABLE minutka_private.activities
  DROP CONSTRAINT activities_system_check;

ALTER TABLE minutka_private.activities
  ADD CONSTRAINT activities_system_check CHECK (
    system IN (
      'bitrix24', 'one_c', 'spreadsheets', 'email', 'messengers', 'crm', 'task_tracker',
      'telephony', 'tender_platform', 'logistics_system', 'learning_platform',
      'paper_or_verbal', 'other'
    )
  );
