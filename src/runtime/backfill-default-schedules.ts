import { DefaultScheduleProvisioner, defaultSchedules } from "../application/default-schedules.js";
import { systemClock } from "../application/runtime-primitives.js";
import { migrationStatus } from "../infrastructure/postgres/postgres-migrator.js";
import { postgresConfigFromEnv } from "../infrastructure/postgres/postgres-config.js";
import { createPostgresPool } from "../infrastructure/postgres/postgres-pool.js";
import { createPostgresScheduleStore } from "../infrastructure/postgres/postgres-schedule-store.js";

const pool = createPostgresPool(postgresConfigFromEnv(process.env));
try {
  const status = await migrationStatus(pool);
  if (status.pending.length) throw new Error(`database migrations are pending: ${status.pending.join(", ")}; run npm run db:migrate`);
  // An employee onboarded before a touch existed keeps every personal setting
  // and only receives the default rows they never had.
  const candidates = await pool.query<{ employee_id: string; timezone: string }>(
    `SELECT profile.employee_id, profile.timezone
     FROM minutka_private.profiles AS profile
     JOIN minutka_private.participants AS participant USING (employee_id)
     WHERE participant.status = 'profile_completed'
       AND EXISTS (
         SELECT 1 FROM unnest($1::text[]) AS required(process_id)
         WHERE NOT EXISTS (
           SELECT 1 FROM minutka_private.process_schedules AS schedule
           WHERE schedule.user_id = profile.employee_id
             AND schedule.kind = 'process'
             AND schedule.process_id = required.process_id
         )
       )
     ORDER BY profile.employee_id`,
    [defaultSchedules.map(({ processId }) => processId)],
  );
  const provisioner = new DefaultScheduleProvisioner(createPostgresScheduleStore(pool), systemClock);
  let createdOwners = 0;
  for (const candidate of candidates.rows) {
    if ((await provisioner.provision(candidate.employee_id, candidate.timezone)).created) createdOwners += 1;
  }
  console.log(JSON.stringify({ candidates: candidates.rowCount, createdOwners }));
} finally {
  await pool.end();
}
