import pg from 'pg';

// node-postgres toma la conexión de las variables estándar PGHOST, PGPORT,
// PGDATABASE, PGUSER y PGPASSWORD que define docker-compose.yml.
export const pool = new pg.Pool({ max: 10 });

// Un cliente inactivo puede perder la conexión (p. ej. si se reinicia postgres);
// sin este manejador el error tumbaría el proceso.
pool.on('error', (err) => {
  console.error('Error en una conexión inactiva del pool', err);
});
