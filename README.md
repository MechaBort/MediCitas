# MediCitas
MediCitas is a multi-tenant SaaS platform that manage medical appointments for numerous clinics and ensures data security



## Diseño de la base de datos

=======================================================
|        			    GEOGRAPHY			                  |
==============================================================

## Countries
- countryId : INT GENERATED ALWAYS AS IDENTITY (PK)
- isoCode : CHAR(3) UNIQUE
- countryName : VARCHAR(50)
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK)

## States
- stateId : INT GENERATED ALWAYS AS IDENTITY (PK)
- countryId : INT (FK)
- stateName : VARCHAR(40)
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK)

## Cities
- cityId : INT GENERATED ALWAYS AS IDENTITY (PK)
- stateId : INT (FK)
- cityName : VARCHAR(50)
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK)

## Addresses
- addressId : INT GENERATED ALWAYS AS IDENTITY (PK)
- cityId : INT (FK)
- address : VARCHAR(100)
- zipCode : VARCHAR(20)
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK)

==============================================================
|        			        USERS 		                     |
==============================================================

## Permissions
- permissionId : INT GENERATED ALWAYS AS IDENTITY (PK)
- permissionName : VARCHAR(50) UNIQUE
- description : VARCHAR(200)
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK)

## Roles (platform_admin, clinic_admin, reception, professional)
- roleId : INT GENERATED ALWAYS AS IDENTITY (PK)
- roleName : VARCHAR(50) UNIQUE - mismo nombre que el rol en Keycloak
- description : VARCHAR(150)
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK)

## PermissionsPerRoles
- permissionPerRoleId : INT GENERATED ALWAYS AS IDENTITY (PK)
- roleId : INT (FK)
- permissionId : INT (FK)
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK)
- UNIQUE (roleId, permissionId)

## Users
- userId : INT GENERATED ALWAYS AS IDENTITY (PK)
- keycloakSub : UUID UNIQUE - identificador que emite Keycloak (claim `sub`)
- clinicId : INT (FK) - NULL solo para el administrador de plataforma (RF2: un usuario pertenece a exactamente una clínica)
- roleId : INT (FK)
- name : VARCHAR(50)
- lastName : VARCHAR(50)
- isActive : BOOLEAN - baja lógica (RF2)
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK)
- UNIQUE (clinicId, userId)
- CHECK ((roleId = platform_admin) = (clinicId IS NULL))

## Professionals (especialización 1:1 de Users; tenant implícito vía Users)
La PK es el mismo `userId`: un profesional *es* un usuario con datos extra. No guarda `clinicId`, porque ya
viene de `Users`. En las demás tablas, la columna `professionalId` contiene ese `userId` y lleva dos FKs:
- `(clinicId, professionalId) → Users(clinicId, userId)`: el profesional es de la misma clínica (I5).
- `professionalId → Professionals(userId)`: ese usuario realmente es un profesional.

- userId : INT (PK, FK → Users)
- licenseNumber : VARCHAR(30) - código del colegio profesional
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK)

## SpecialtiesPerProfessionals (tenant implícito vía professionalId)
Sin `clinicId`: las especialidades son un catálogo global, así que no hay forma de mezclar clínicas aquí y la
clínica se obtiene del profesional.
- specialtyPerProfessionalId : INT GENERATED ALWAYS AS IDENTITY (PK)
- professionalId : INT (FK → Professionals(userId))
- specialtyId : INT (FK)
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK)
- UNIQUE (professionalId, specialtyId)

## ServicesPerProfessionals [tenant] (RF4: servicios que el profesional está habilitado para atender)
Desnormalización deliberada: `clinicId` es derivable del profesional (y del servicio), pero se guarda porque es la columna que comparten las dos FKs compuestas, lo que obliga a que profesional y servicio sean de la misma clínica.
- servicePerProfessionalId : INT GENERATED ALWAYS AS IDENTITY (PK)
- clinicId : INT
- professionalId : INT
- serviceId : INT
- FK (clinicId, professionalId) → Users(clinicId, userId)
- FK professionalId → Professionals(userId)
- FK (clinicId, serviceId) → Services(clinicId, serviceId)
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK)
- UNIQUE (clinicId, professionalId, serviceId)

==============================================================
|        			   AGENDA (horarios y bloqueos)          |
==============================================================

## ProfessionalSchedules [tenant] (RF5: bloques de atención, varios por día, pueden variar de una semana a otra)
Cada fila es un bloque concreto de atención (p. ej. lunes 2026-11-02 08:00–12:00). El horario semanal se define cargando los bloques de esa semana; si la semana siguiente cambia, se cargan otros bloques. Los bloques se generan a partir de la hora local de la clínica (`Clinics.timeZone`) y se guardan como instantes absolutos.
- scheduleId : INT GENERATED ALWAYS AS IDENTITY (PK)
- clinicId : INT (FK)
- professionalId : INT - FK (clinicId, professionalId) → Users(clinicId, userId) y FK professionalId → Professionals(userId)
- period : TSTZRANGE - `[inicio, fin)` del bloque
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK)
- CHECK (NOT isempty(period)) - un rango vacío (`[08:00, 08:00)`) no es NULL, por eso NOT NULL no basta
- EXCLUDE USING gist (professionalId WITH =, period WITH &&) - un profesional no tiene bloques solapados

Índice (sirve a RF7: bloques de un profesional que tocan una fecha):
```sql
CREATE INDEX ix_schedules_prof_period
    ON ProfessionalSchedules USING gist (clinicId, professionalId, period);
```
La restricción `EXCLUDE` ya crea un índice GiST sobre `(professionalId, period)`; el índice anterior agrega `clinicId` al frente porque toda consulta de la aplicación filtra por clínica.

## Blockades [tenant] (RF6: vacaciones o permisos)
- blockadeId : INT GENERATED ALWAYS AS IDENTITY (PK)
- clinicId : INT (FK)
- professionalId : INT - FK (clinicId, professionalId) → Users(clinicId, userId) y FK professionalId → Professionals(userId)
- period : TSTZRANGE - `[inicio, fin)` del bloqueo
- reason : TEXT
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK)
- CHECK (NOT isempty(period))

```sql
CREATE INDEX ix_blockades_prof_period
    ON Blockades USING gist (clinicId, professionalId, period);
```

==============================================================
|        				   PATIENTS                          |
==============================================================

## Patients [tenant] (RF14 — no son usuarios del sistema, no tienen credenciales)
- patientId : INT GENERATED ALWAYS AS IDENTITY (PK)
- clinicId : INT (FK)
- identification : VARCHAR(30)
- name : VARCHAR(50)
- lastName : VARCHAR(50)
- birthDate : DATE
- genderId : SMALLINT (FK) - NULL si el paciente no lo indica
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK)
- UNIQUE (clinicId, identification)
- UNIQUE (clinicId, patientId)

## Genders (femenino, masculino, otro, prefiere no decir)
- genderId : SMALLINT (PK)
- genderName : VARCHAR(30) UNIQUE

## ContactTypes (Telefono, email)
- contactTypeId : INT GENERATED ALWAYS AS IDENTITY (PK)
- contactTypeName : VARCHAR(50) UNIQUE
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK)

## PatientContacts [tenant] (dato sensible: toda lectura/escritura se registra en la bitácora, RF18)
- contactId : INT GENERATED ALWAYS AS IDENTITY (PK)
- clinicId : INT (FK)
- patientId : INT - FK compuesta (clinicId, patientId) → Patients
- contactTypeId : INT (FK)
- contactValue : VARCHAR(320) - 320 por el máximo de un correo (RFC 5321)
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK)

## ProfessionalContacts [tenant] (para que recepción pueda contactar al profesional)
Tabla separada de `PatientContacts` porque tienen reglas distintas: los contactos de pacientes van a la
bitácora (RF18) y los de profesionales no; y así cada FK es obligatoria en lugar de tener dos FKs opcionales.
- contactId : INT GENERATED ALWAYS AS IDENTITY (PK)
- clinicId : INT (FK)
- professionalId : INT - FK (clinicId, professionalId) → Users(clinicId, userId) y FK professionalId → Professionals(userId)
- contactTypeId : INT (FK)
- contactValue : VARCHAR(320)
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK)
- UNIQUE (professionalId, contactTypeId, contactValue)

==============================================================
|        			 Clinics and appointments                |
==============================================================
## Clinics
- clinicId : INT GENERATED ALWAYS AS IDENTITY (PK)
- clinicCode : VARCHAR(30) UNIQUE - identificador de la clínica (RF1)
- clinicName : VARCHAR(75)
- timeZone : VARCHAR(64) - nombre IANA, p. ej. `America/Costa_Rica`; validado contra `pg_timezone_names`
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK)

## ClinicsAddresses
- clinicAddressId : INT GENERATED ALWAYS AS IDENTITY (PK)
- clinicId : INT (FK)
- addressId : INT (FK)
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK)

## Specialties
- specialtyId : INT GENERATED ALWAYS AS IDENTITY (PK)
- specialtyName : VARCHAR(50) UNIQUE

## Services [tenant] (RF3)
- serviceId : INT GENERATED ALWAYS AS IDENTITY (PK)
- clinicId : INT (FK)
- serviceName : VARCHAR(63)
- durationMinutes : INT - CHECK (durationMinutes > 0)
- specialtyId : INT (FK)
- isActive : BOOLEAN
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK)
- UNIQUE (clinicId, serviceId)

## AppointmentStatuses (reservada, atendida, ausente, cancelada, reprogramada)
- appointmentStatusId : SMALLINT (PK)
- statusName : VARCHAR(12) UNIQUE
- isFinal : BOOLEAN - los cuatro estados finales no admiten salida (RF13)

## Appointments [tenant]
- appointmentId : BIGINT GENERATED ALWAYS AS IDENTITY (PK)
- clinicId : INT (FK)
- patientId : INT - FK compuesta (clinicId, patientId) → Patients
- professionalId : INT - FK (clinicId, professionalId) → Users(clinicId, userId) y FK professionalId → Professionals(userId)
- serviceId : INT - FK compuesta (clinicId, serviceId) → Services; además (clinicId, professionalId, serviceId) → ServicesPerProfessionals
- appointmentStatusId : SMALLINT (FK)
- period : TSTZRANGE - `[inicio, inicio + duración del servicio)`; lo calcula un trigger, la aplicación no lo envía (I4)
- appointmentDescription : TEXT - motivo de la consulta
- cancelReason : TEXT - NULL (RF11)
- cancelledBy : INT (FK → Users) - NULL (RF11)
- cancelledAt : TIMESTAMPTZ - NULL
- rescheduledFromId : BIGINT (FK → Appointments) - NULL; la cita nueva apunta a la que reemplaza (RF10)
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ
- updatedBy : INT (FK)
- UNIQUE (clinicId, appointmentId)
- UNIQUE (rescheduledFromId) - una cita solo se reprograma una vez
- CHECK ((appointmentStatusId = cancelada) = (cancelReason IS NOT NULL AND cancelledBy IS NOT NULL))
- EXCLUDE USING gist (professionalId WITH =, period WITH &&) WHERE (appointmentStatusId = reservada) - **I1**
- EXCLUDE USING gist (patientId WITH =, period WITH &&) WHERE (appointmentStatusId = reservada) - **I2**

Reprogramar (RF10) = en una sola transacción, pasar la cita original a `reprogramada` e insertar la nueva con `rescheduledFromId`. Como la original deja de estar `reservada`, su espacio sale de la restricción `EXCLUDE` en el mismo commit en que se ocupa el nuevo.

Desnormalización deliberada: el fin de la cita se puede derivar de `serviceId` + inicio. Se guarda porque (a) la restricción `EXCLUDE` solo puede usar columnas de la propia fila, no consultar `Services`; y (b) la cita conserva la duración con la que se reservó aunque el servicio cambie después su duración. El trigger de inserción es el único que la calcula, de modo que ninguna operación la altera por su cuenta (I4).

## ClinicalNotes [tenant] (RF15 — dato más sensible; solo la escribe el profesional que atendió la cita)
- clinicalNoteId : BIGINT GENERATED ALWAYS AS IDENTITY (PK)
- clinicId : INT (FK)
- appointmentId : BIGINT UNIQUE - FK compuesta (clinicId, appointmentId) → Appointments; la cita debe estar `atendida`
- professionalId : INT - FK (clinicId, professionalId) → Users(clinicId, userId) y FK professionalId → Professionals(userId); debe coincidir con el de la cita
- noteText : TEXT
- createdAt : TIMESTAMPTZ
- updatedAt : TIMESTAMPTZ

==============================================================
|        					logs              	 	         |
==============================================================
## eventTypes (read, create, update, ...)
- eventTypeId : SMALLINT (PK)
- name : VARCHAR(50) UNIQUE
- description : VARCHAR(150)

## dataObjects (clinical_note, patient_contact, ...)
- dataObjectId : SMALLINT (PK)
- name : VARCHAR(50) UNIQUE
- description : VARCHAR(100)

## severities
- severityId : SMALLINT (PK)
- name : VARCHAR(50) UNIQUE
- description : VARCHAR(100)

## auditLogs [tenant] (RF18 / RF19 — append-only protegida en el motor, I6)
- logId : BIGINT GENERATED ALWAYS AS IDENTITY (PK)
- clinicId : INT (FK)
- userId : INT (FK) - quién
- eventTypeId : SMALLINT (FK) - qué acción
- dataObjectId : SMALLINT (FK) - sobre qué tipo de dato
- objectId : BIGINT - id del registro tocado (nota o contacto)
- patientId : INT - FK compuesta (clinicId, patientId) → Patients; sobre cuál paciente
- description : VARCHAR(255)
- metadata : JSONB
- createdAt : TIMESTAMPTZ DEFAULT now() - cuándo

Protección: el rol de la aplicación solo tiene `INSERT` y `SELECT` (`REVOKE UPDATE, DELETE, TRUNCATE`), y un trigger `BEFORE UPDATE OR DELETE` lanza una excepción aunque alguien conceda el permiso por error.

```sql
CREATE INDEX ix_audit_clinic_patient_date ON auditLogs (clinicId, patientId, createdAt);
CREATE INDEX ix_audit_clinic_user_date    ON auditLogs (clinicId, userId, createdAt);
```

## systemErrorsLogs
- errorId : BIGINT GENERATED ALWAYS AS IDENTITY (PK)
- severityId : SMALLINT (FK)
- processUuid : UUID
- processName : VARCHAR(100)
- stepName : VARCHAR(100)
- inputData : JSONB
- errorMessage : TEXT
- createdAt : TIMESTAMPTZ DEFAULT now() ESTAMP
- metadata : JSON 			

## systemErrorsLogs 
- errorId : INT AUTO_INCREMENT (PK) 
- severityId : INT (FK) 
- processUuid : VARCHAR(100) 
- processName : VARCHAR(100) 
- stepName : VARCHAR(100) 
- inputData : JSON 
- errorMesage : TEXT 
- creadetAt : DATE 