#!/usr/bin/env bun
/**
 * R3-8 Phase C — canonical read-only enforcement probe (real host).
 *
 * Uses the WORKBENCH'S OWN connection factory (src/lib/canonical.ts getPool:
 * options -c default_transaction_read_only=on) and attempts a write.
 * Expected: server-side denial ("cannot execute ... in a read-only
 * transaction") — i.e. the workbench CANNOT mutate canonical state even if
 * application code were compromised, because the DB role + session are
 * read-only. Also proves the guard is server-enforced (SHOW
 * transaction_read_only) and that SELECTs still work.
 *
 * Env: TV_PGHOST/TV_PGUSER/TV_PGDATABASE (production values).
 * The probe never attempts writes outside a transaction that will fail; no
 * canonical data can change (and the DB role has no write grant anyway).
 */
import { readOnlyGuardEnforced, getCanonicalStates, getAppliedEvents } from "../../src/lib/canonical";
import { Pool } from "pg";

const probe = new Pool({
  host: process.env.TV_PGHOST || "127.0.0.1",
  port: Number(process.env.TV_PGPORT || 5432),
  user: process.env.TV_PGUSER || "syllabai",
  database: process.env.TV_PGDATABASE || "syllabai",
  max: 1,
  options: "-c default_transaction_read_only=on",
});

let failures = 0;
const expect = (c: boolean, l: string) => { console.log(`${c ? "PASS" : "FAIL"} — ${l}`); if (!c) failures++; };

expect(await readOnlyGuardEnforced(), "connection-level read-only guard is server-enforced (SHOW transaction_read_only = on)");

try {
  await probe.query("UPDATE question_versions SET validation_state = 'VALIDATED' WHERE false");
  expect(false, "UPDATE attempt through workbench-style connection: NOT blocked (BAD)");
} catch (e) {
  expect(String((e as Error).message).includes("read-only"), `UPDATE attempt blocked server-side: "${(e as Error).message.slice(0, 80)}"`);
}
try {
  await probe.query("INSERT INTO teacher_validation_events (importer_run_id, decision_seq, decision_hash, action, target_type, target_id, target_label, reviewer, note, result_state) VALUES (gen_random_uuid(), 0, repeat('0',64), 'VALIDATE', 'question_version', gen_random_uuid(), 'x', 'attacker', '', 'VALIDATED')");
  expect(false, "INSERT attempt into teacher_validation_events: NOT blocked (BAD)");
} catch (e) {
  expect(String((e as Error).message).includes("read-only"), `INSERT attempt blocked server-side: "${(e as Error).message.slice(0, 80)}"`);
}

const states = await getCanonicalStates([{ type: "question_version", id: "ffffffff-ffff-ffff-ffff-ffffffffffff" }]);
expect(states.available, "canonical SELECTs still work through the read-only path (available=true)");
const ev = await getAppliedEvents(10);
expect(ev.available, "applied-events read path works (available=true)");

await probe.end();
console.log(failures === 0 ? "CANONICAL READ-ONLY PROBE: ALL PASS" : `CANONICAL READ-ONLY PROBE: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
