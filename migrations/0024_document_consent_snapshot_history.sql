-- minutka_private.consents is the current consent snapshot: accepting a new
-- privacy version replaces the previous row. For the limited pilot, prior
-- versions exist only in consent_accepted audit events and follow their
-- retention/deletion lifecycle; there is no append-only consent ledger.
COMMENT ON TABLE minutka_private.consents IS
  'Current consent snapshot. Prior accepted versions exist only in consent_accepted audit events and follow their retention/deletion lifecycle.';
