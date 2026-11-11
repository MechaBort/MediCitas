# Uso de IA

Herramienta: Claude Code (Anthropic).

## En qué se usó
- Revisión del diseño inicial de la base de datos contra el enunciado: señaló requisitos no cubiertos e inconsistencias.
- Propuestas de diseño que el grupo discutió y aceptó, modificó o rechazó: restricciones `EXCLUDE` con `tstzrange` para I1/I2, FKs compuestas con `clinicId` para I5, tabla `Professionals` como especialización de `Users`, roles de base de datos e índices.
- Redacción de borradores de las secciones de decisiones de diseño del README.
- Implementación de las rutas de catálogo de servicios (`RF3`, `/services`) y profesionales con sus especialidades y servicios habilitados (`RF4`, `/professionals`) en `services/admin`, junto con sus pruebas de integración y de aislamiento entre clínicas (`I5`) en `tests/integration/services-professionals.test.js`.
