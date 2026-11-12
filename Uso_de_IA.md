# Uso de IA

Herramienta: Claude Code (Anthropic).

## En qué se usó
- Revisión del diseño inicial de la base de datos contra el enunciado: señaló requisitos no cubiertos e inconsistencias.
- Propuestas de diseño que el grupo discutió y aceptó, modificó o rechazó: restricciones `EXCLUDE` con `tstzrange` para I1/I2, FKs compuestas con `clinicId` para I5, tabla `Professionals` como especialización de `Users`, roles de base de datos e índices.
- Redacción de borradores de las secciones de decisiones de diseño del README.
- Implementación asistida de las rutas de pacientes (`RF14`, `/patients`) con registro de auditoría de contactos (`RF18`) en `services/clinical` y del historial de citas de un paciente (`RF16`, `GET /appointments?patientId=…`) en `services/agenda`, junto con sus pruebas de integración (`tests/integration/patients-history.test.js`).
