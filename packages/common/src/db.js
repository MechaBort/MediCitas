import pg from 'pg';

// node-postgres toma la conexión de las variables estándar PGHOST, PGPORT,
// PGDATABASE, PGUSER y PGPASSWORD que define docker-compose.yml.
export const pool = new pg.Pool({ max: 10 });

// Un cliente inactivo puede perder la conexión (p. ej. si se reinicia postgres);
// sin este manejador el error tumbaría el proceso.
pool.on('error', (err) => {
  console.error('Error en una conexión inactiva del pool', err);
});

// Roles de base de datos con los que puede trabajar una petición (ver db/sql/02-grants.sql).
// SET ROLE no acepta parámetros ($1), así que el nombre se valida contra esta lista antes
// de ponerlo en el SQL: a esa sentencia nunca llega texto que venga del cliente.
const DB_ROLES = new Set(['mc_platform', 'mc_clinic_admin', 'mc_reception', 'mc_professional']);

const DEADLOCK = '40P01';
const MAX_ATTEMPTS = 3;

// Ejecuta fn(client) dentro de una transacción con el rol de base indicado y devuelve
// lo que fn devuelva. Si fn lanza un error, se hace ROLLBACK y el error sigue hacia arriba.
//
// - El nivel de aislamiento se fija explícito en READ COMMITTED en lugar de depender del
//   valor por omisión (ver "Concurrencia y nivel de aislamiento" en el README).
// - SET LOCAL ROLE dura solo hasta el COMMIT o ROLLBACK: la conexión vuelve al pool como
//   mc_app, sin permisos, y la siguiente petición no hereda el rol de esta.
// - Si Postgres aborta la transacción por un deadlock, se repite completa. Por eso fn no
//   debe tener efectos fuera de la base (invalidar la caché, por ejemplo, va después).
export async function withTransaction(dbRole, fn) {
  if (!DB_ROLES.has(dbRole)) {
    throw new Error(`Rol de base de datos no permitido: ${dbRole}`);
  }

  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query(`SET LOCAL ROLE ${dbRole}`);
      const result = await fn(client);
      await client.query('COMMIT');
      client.release();
      return result;
    } catch (err) {
      // Una conexión que ni siquiera puede hacer ROLLBACK está rota: se descarta en vez
      // de devolverla al pool.
      const broken = await client.query('ROLLBACK').then(() => false, () => true);
      client.release(broken);

      if (err.code === DEADLOCK && attempt < MAX_ATTEMPTS) {
        console.warn(`Deadlock detectado; reintento ${attempt + 1} de ${MAX_ATTEMPTS}`);
        continue;
      }
      throw err;
    }
  }
}
