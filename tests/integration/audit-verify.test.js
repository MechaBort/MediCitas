// Módulo §9 (auditoría verificable) e I6: protección append-only en el motor y cadena de huellas
// SHA-256 por clínica en clinical.audit_logs, verificable desde GET /audit/verify.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, requireStack, token } from './helpers.js';
import { ownerDb } from './db.js';

requireStack();
const db = ownerDb();

let sjAdmin;
let cartagoAdmin;
let bogotaAdmin;
let sjReception;
let sjProfToken;
let platformToken;
let sjClinicId;
let sjUserId;
let sjPatientId;
const createdLogIds = [];

before(async () => {
  [sjAdmin, cartagoAdmin, bogotaAdmin, sjReception, sjProfToken, platformToken] = await Promise.all([
    token('admin.sanjose'),
    token('admin.cartago'),
    token('admin.bogota'),
    token('recepcion.sanjose'),
    token('laura.mora'),
    token('plataforma'),
  ]);

  const { rows } = await db.query(
    `SELECT u.clinic_id AS "clinicId",
            u.user_id   AS "userId",
            (SELECT p.patient_id FROM clinical.patients p WHERE p.clinic_id = u.clinic_id ORDER BY p.patient_id LIMIT 1) AS "patientId"
       FROM admin.users u
      WHERE u.clinic_id = 1 AND u.role_id = 3 AND u.is_active
      LIMIT 1`,
  );
  sjClinicId = rows[0].clinicId;
  sjUserId = rows[0].userId;
  sjPatientId = rows[0].patientId;
});

test('I6: ningún rol de la aplicación tiene UPDATE, DELETE ni TRUNCATE sobre audit_logs, y los triggers rechazan cambios con MC005', async () => {
  // Capa 1: privilegios de tabla para los cuatro roles de aplicación y los tres usuarios de servicio.
  const { rows: privRows } = await db.query(
    `SELECT r.rolname AS role,
            has_table_privilege(r.rolname, 'clinical.audit_logs', 'UPDATE')   AS can_update,
            has_table_privilege(r.rolname, 'clinical.audit_logs', 'DELETE')   AS can_delete,
            has_table_privilege(r.rolname, 'clinical.audit_logs', 'TRUNCATE') AS can_truncate
       FROM pg_roles r
      WHERE r.rolname IN (
        'mc_platform', 'mc_clinic_admin', 'mc_reception', 'mc_professional',
        'mc_admin_svc', 'mc_agenda_svc', 'mc_clinical_svc'
      )`,
  );
  assert.equal(privRows.length, 7);
  for (const row of privRows) {
    assert.equal(row.can_update, false, `${row.role} no debe tener UPDATE en audit_logs`);
    assert.equal(row.can_delete, false, `${row.role} no debe tener DELETE en audit_logs`);
    assert.equal(row.can_truncate, false, `${row.role} no debe tener TRUNCATE en audit_logs`);
  }

  // Capa 2: incluso el dueño de la tabla (mc_owner) es rechazado por los triggers con MC005.
  await assert.rejects(
    db.query(`UPDATE clinical.audit_logs SET description = 'Intento' WHERE log_id = 1`),
    { code: 'MC005' },
  );
  await assert.rejects(
    db.query(`DELETE FROM clinical.audit_logs WHERE log_id = 1`),
    { code: 'MC005' },
  );
  await assert.rejects(
    db.query(`TRUNCATE clinical.audit_logs`),
    { code: 'MC005' },
  );
});

test('Módulo §9, I6: GET /audit/verify confirma que la cadena de huellas SHA-256 nace íntegra en cada clínica', async () => {
  for (const [adminToken, expectedClinicId] of [
    [sjAdmin, 1],
    [cartagoAdmin, 2],
    [bogotaAdmin, 3],
  ]) {
    const res = await api('GET', '/audit/verify', { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.service, 'clinical');
    assert.equal(res.body.clinicId, expectedClinicId);
    assert.equal(res.body.valid, true);
    assert.ok(res.body.checkedCount > 0);
    assert.equal(typeof res.body.lastLogId, 'number');
    assert.match(res.body.lastRowHash, /^[0-9a-f]{64}$/);
    assert.equal(res.body.firstBrokenLogId, null);
    assert.equal(res.body.failureReason, null);
  }

  // En la base, el primer registro de San José tiene prev_hash NULL y los siguientes enlazan sin huecos.
  const { rows } = await db.query(
    `SELECT log_id, prev_hash, row_hash
       FROM clinical.audit_logs
      WHERE clinic_id = $1
      ORDER BY log_id ASC
      LIMIT 5`,
    [sjClinicId],
  );
  assert.ok(rows.length >= 2);
  assert.equal(rows[0].prev_hash, null);
  for (let i = 1; i < rows.length; i += 1) {
    assert.equal(rows[i].prev_hash, rows[i - 1].row_hash);
  }
});

test('Módulo §9: inserciones concurrentes en la misma clínica serializan con pg_advisory_xact_lock sin bifurcar la cadena', async () => {
  const beforeRes = await api('GET', '/audit/verify', { token: sjAdmin });
  assert.equal(beforeRes.status, 200);
  assert.equal(beforeRes.body.valid, true);

  const concurrency = 8;
  const inserted = await Promise.all(
    Array.from({ length: concurrency }, (_, idx) =>
      db.query(
        `INSERT INTO clinical.audit_logs (clinic_id, user_id, event_type_id, data_object_id, object_id, patient_id, description, metadata)
         VALUES ($1, $2, 1, 2, $3, $4, $5, $6)
         RETURNING log_id`,
        [
          sjClinicId,
          sjUserId,
          idx + 1,
          sjPatientId,
          `Lectura concurrente de prueba #${idx + 1}`,
          JSON.stringify({ batch: 'concurrent-test', idx: idx + 1 }),
        ],
      ),
    ),
  );

  for (const r of inserted) {
    createdLogIds.push(r.rows[0].log_id);
  }

  const afterRes = await api('GET', '/audit/verify', { token: sjAdmin });
  assert.equal(afterRes.status, 200);
  assert.equal(afterRes.body.valid, true);
  assert.equal(afterRes.body.checkedCount, beforeRes.body.checkedCount + concurrency);
  assert.equal(afterRes.body.firstBrokenLogId, null);
});

test('Módulo §9, I6, I5: si mc_owner desactiva el trigger y altera un registro, GET /audit/verify señala exactamente ese log_id sin afectar a otras clínicas', async () => {
  // Insertamos dos registros nuevos para alterar el primero y dejar otro detrás.
  const firstInsert = await db.query(
    `INSERT INTO clinical.audit_logs (clinic_id, user_id, event_type_id, data_object_id, object_id, patient_id, description)
     VALUES ($1, $2, 1, 2, 101, $3, 'Registro íntegro antes de prueba de manipulación')
     RETURNING log_id, description`,
    [sjClinicId, sjUserId, sjPatientId],
  );
  const targetLogId = Number(firstInsert.rows[0].log_id);
  const originalDescription = firstInsert.rows[0].description;
  createdLogIds.push(targetLogId);

  const secondInsert = await db.query(
    `INSERT INTO clinical.audit_logs (clinic_id, user_id, event_type_id, data_object_id, object_id, patient_id, description)
     VALUES ($1, $2, 1, 2, 102, $3, 'Registro posterior al manipulado')
     RETURNING log_id`,
    [sjClinicId, sjUserId, sjPatientId],
  );
  createdLogIds.push(Number(secondInsert.rows[0].log_id));

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE clinical.audit_logs DISABLE TRIGGER trg_audit_logs_append_only');
    await client.query(
      `UPDATE clinical.audit_logs
          SET description = 'Descripción adulterada directamente en la base'
        WHERE log_id = $1`,
      [targetLogId],
    );
    await client.query('ALTER TABLE clinical.audit_logs ENABLE TRIGGER trg_audit_logs_append_only');
    await client.query('COMMIT');

    // San José detecta el registro adulterado exacto.
    const sjVerify = await api('GET', '/audit/verify', { token: sjAdmin });
    assert.equal(sjVerify.status, 200);
    assert.equal(sjVerify.body.valid, false);
    assert.equal(sjVerify.body.firstBrokenLogId, targetLogId);
    assert.match(sjVerify.body.failureReason ?? '', /row_hash/);

    // I5: la cadena de Cartago sigue íntegra.
    const cartagoVerify = await api('GET', '/audit/verify', { token: cartagoAdmin });
    assert.equal(cartagoVerify.status, 200);
    assert.equal(cartagoVerify.body.valid, true);
    assert.equal(cartagoVerify.body.firstBrokenLogId, null);
  } finally {
    await client.query('BEGIN');
    await client.query('ALTER TABLE clinical.audit_logs DISABLE TRIGGER trg_audit_logs_append_only');
    await client.query(
      `UPDATE clinical.audit_logs SET description = $1 WHERE log_id = $2`,
      [originalDescription, targetLogId],
    );
    await client.query('ALTER TABLE clinical.audit_logs ENABLE TRIGGER trg_audit_logs_append_only');
    await client.query('COMMIT');
    client.release();
  }

  // Una vez restaurado el contenido original, la cadena vuelve a ser válida.
  const restoredVerify = await api('GET', '/audit/verify', { token: sjAdmin });
  assert.equal(restoredVerify.status, 200);
  assert.equal(restoredVerify.body.valid, true);
  assert.equal(restoredVerify.body.firstBrokenLogId, null);
});

test('Módulo §9, I6: si mc_owner desactiva el trigger y borra un eslabón intermedio, GET /audit/verify detecta la ruptura en el registro siguiente', async () => {
  const firstInsert = await db.query(
    `INSERT INTO clinical.audit_logs (clinic_id, user_id, event_type_id, data_object_id, object_id, patient_id, description)
     VALUES ($1, $2, 1, 2, 201, $3, 'Eslabón intermedio que será borrado')
     RETURNING log_id`,
    [sjClinicId, sjUserId, sjPatientId],
  );
  const deletedLogId = Number(firstInsert.rows[0].log_id);

  const secondInsert = await db.query(
    `INSERT INTO clinical.audit_logs (clinic_id, user_id, event_type_id, data_object_id, object_id, patient_id, description)
     VALUES ($1, $2, 1, 2, 202, $3, 'Eslabón siguiente cuyo prev_hash quedará huérfano')
     RETURNING log_id`,
    [sjClinicId, sjUserId, sjPatientId],
  );
  const nextLogId = Number(secondInsert.rows[0].log_id);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE clinical.audit_logs DISABLE TRIGGER trg_audit_logs_append_only');
    await client.query('DELETE FROM clinical.audit_logs WHERE log_id = $1', [deletedLogId]);
    await client.query('ALTER TABLE clinical.audit_logs ENABLE TRIGGER trg_audit_logs_append_only');
    await client.query('COMMIT');

    const verifyRes = await api('GET', '/audit/verify', { token: sjAdmin });
    assert.equal(verifyRes.status, 200);
    assert.equal(verifyRes.body.valid, false);
    assert.equal(verifyRes.body.firstBrokenLogId, nextLogId);
    assert.match(verifyRes.body.failureReason ?? '', /prev_hash/);
  } finally {
    await client.query('BEGIN');
    await client.query('ALTER TABLE clinical.audit_logs DISABLE TRIGGER trg_audit_logs_append_only');
    await client.query('DELETE FROM clinical.audit_logs WHERE log_id = ANY($1::bigint[])', [
      [deletedLogId, nextLogId],
    ]);
    await client.query('ALTER TABLE clinical.audit_logs ENABLE TRIGGER trg_audit_logs_append_only');
    await client.query('COMMIT');
    client.release();
  }

  const cleanVerify = await api('GET', '/audit/verify', { token: sjAdmin });
  assert.equal(cleanVerify.status, 200);
  assert.equal(cleanVerify.body.valid, true);
});

test('Módulo §9, RF17, I5: GET /audit/verify exige el permiso audit.read (401/403) y rechaza query params desconocidos (400)', async () => {
  assert.equal((await api('GET', '/audit/verify')).status, 401);
  assert.equal((await api('GET', '/audit/verify', { token: sjReception })).status, 403);
  assert.equal((await api('GET', '/audit/verify', { token: sjProfToken })).status, 403);
  assert.equal((await api('GET', '/audit/verify', { token: platformToken })).status, 403);
  assert.equal((await api('GET', '/audit/verify?clinicId=2', { token: sjAdmin })).status, 400);
});
