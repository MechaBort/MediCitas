# Uso de IA

Herramienta: Claude Code (Anthropic).

## En qué se usó
- Revisión del diseño inicial de la base de datos contra el enunciado: señaló requisitos no cubiertos e inconsistencias.
- Propuestas de diseño que el grupo discutió y aceptó, modificó o rechazó: restricciones `EXCLUDE` con `tstzrange` para I1/I2, FKs compuestas con `clinicId` para I5, tabla `Professionals` como especialización de `Users`, roles de base de datos e índices.
- Redacción de borradores de las secciones de decisiones de diseño del README.
- Implementación del Módulo §9 (auditoría verificable con cadena de huellas SHA-256 por clínica en `clinical.audit_logs`, trigger `BEFORE INSERT` con `pg_advisory_xact_lock`, función `clinical.verify_audit_chain` y ruta `GET /audit/verify`) y sus pruebas automatizadas de integración (`I6` y detección de manipulación).
