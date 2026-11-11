// Corte de los huecos libres en espacios reservables (RF7, RF8).
//
// La base calcula los huecos libres de un profesional en un día (availability.js); aquí se cortan según la duración
// del servicio. Se separan así para que la caché (etapa siguiente) guarde los huecos una sola vez por profesional y
// día: cada servicio los corta con su propia duración, sin otra entrada en Redis. Es una función pura, sin base ni
// Redis, para probarla con pruebas unitarias (services/agenda/test/slots.test.js).

// gaps: [{ start, end }] con Date o texto ISO 8601, en orden. Devuelve [{ start: Date, end: Date }]: espacios
// seguidos desde el inicio de cada hueco, todos de la duración del servicio. Lo que sobra al final de un hueco
// (menos que una duración) no alcanza para un espacio. Un espacio que empieza en `now` o antes no se devuelve,
// porque RF9 rechazaría reservarlo.
export function sliceGaps(gaps, durationMinutes, now = new Date()) {
  const step = durationMinutes * 60_000;
  const nowMs = new Date(now).getTime();
  const slots = [];
  for (const gap of gaps) {
    const end = new Date(gap.end).getTime();
    for (let t = new Date(gap.start).getTime(); t + step <= end; t += step) {
      if (t > nowMs) slots.push({ start: new Date(t), end: new Date(t + step) });
    }
  }
  return slots;
}
