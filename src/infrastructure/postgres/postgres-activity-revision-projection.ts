export const canonicalActivityRevisionChangedAtSql =
  `to_char(history.changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
