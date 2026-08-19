DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM minutka_private.messages
    WHERE subject_key IS NULL
  ) THEN
    RAISE EXCEPTION 'minutka_private.messages contains rows without subject_key';
  END IF;
END $$;

ALTER TABLE minutka_private.messages
  ALTER COLUMN subject_key SET NOT NULL;
