# MediCitas
MediCitas is a multi-tenant SaaS platform that manage medical appointments for numerous clinics and ensures data security



## Diseño de la base de datos

==============================================================
|        			    GEOGRAPHY			                  |                                     
==============================================================

## Countries
- countryId : INT IDENTITY(1,1) (PK)
- isoCode : UNIQUE VARCHAR (3) 
- countryName : VARCHAR (50)
- isActive : BIT
- createdAt : DATETIME2
- updatedAt : DATETIME2
- updatedBy : INT (FK)

## States
- stateId : INT IDENTITY(1,1) (PK)
- countryId : INT (FK)
- stateName : VARCHAR (40)
- isActive : BIT
- createdAt : DATETIME2
- updatedAt : DATETIME2
- updatedBy : INT (FK)
- TimeZoneid : INT (FK)

## Cities
- cityId : INT IDENTITY(1,1) (PK)
- stateId : INT (FK)
- cityName : VARCHAR (50)
- isActive : BIT
- createdAt : DATETIME2
- updatedAt : DATETIME2
- updatedBy : INT (FK)

## TimeZones
- TimeZoneid : INT IDENTITY(1,1) (PK)
- name : VARCHAR(6) - UTC-12, UTC+11

## Addresses
- addressId : INT IDENTITY(1,1) (PK)
- cityId : INT (FK)
- address : VARCHAR (100)
- zipCode : VARCHAR (20)
- position : GEOGRAPHY
- isActive : BIT
- createdAt : DATETIME2
- updatedAt : DATETIME2
- updatedBy : INT (FK)

==============================================================
|        			        USERS 		                     |                                     
==============================================================

## Permissions
- permissionId : INT IDENTITY(1,1) (PK)
- permissionName : VARCHAR (50)
- description : VARCHAR (200)
- isActive : BIT
- createdAt : DATETIME2
- updatedAt : DATETIME2
- updatedBy : INT (FK)

## Roles
- roleId : INT IDENTITY(1,1) (PK)
- roleName : VARCHAR (50)
- description : VARCHAR (150)
- isActive : BIT
- createdAt : DATETIME2
- updatedAt : DATETIME2
- updatedBy : INT (FK)

## PermissionsPerRoles
- permissionPerRoleId : INT IDENTITY(1,1) (PK)
- roleId : INT(FK)
- permissionId : INT(FK)
- isActive : BIT
- createdAt : DATETIME2
- updatedAt : DATETIME2
- updatedBy : INT (FK)

## UsersPerRoles
- userPerRoleId : INT IDENTITY(1,1) (PK)
- userId : INT(FK)
- roleId : INT(FK)
- isActive : BIT
- createdAt : DATETIME2
- updatedAt : DATETIME2
- updatedBy : INT (FK)

## Users
- userId : INT IDENTITY(1,1) (PK)
- specialtyId: INT (FK) - NULL
- name : VARCHAR(50)
- lastName : VARCHAR(50)
- date: DATE 
- phoneNumber: VARCHAR(20) - NULL, unique
- gender : bit (0 = mujer, 1 = hombre) 
- email: VARCHAR(320)	- (Se colocan 320 porque es el estandar técnico oficial RFC 5321) NULL, unique
- passwordHash: VARCHAR (255) - NULL, unique
- isActive : BIT
- createdAt : DATETIME2
- updatedAt : DATETIME2
- updatedBy : INT (FK)

## SpecialtiesPerUsers
- SpecialtiePerUserId : INT IDENTITY(1,1) (PK)
- userId : INT (FK) - NULL
- specialtyId: INT (FK) - NULL
- isActive : BIT
- createdAt : DATETIME2
- updatedAt : DATETIME2
- updatedBy : INT (FK)

## UsersPerClinics
- UserPerClinicId: INT IDENTITY(1,1) (PK)
- userId : INT (FK)
- clinicId: INT (FK)
- isActive : BIT
- createdAt : DATETIME2
- updatedAt : DATETIME2
- updatedBy : INT (FK)

## blockades (Vacaciones o permisos de no ir a bretear)
- blockadeId : INT IDENTITY (1,1) (PK)
- description: VARCHAR(MAX)
- userId: INT (FK)
- startDate: DATETIME2
- finishDate: DATETIME2
- createdAt: DATETIME2
- updatedAt: DATETIME2
- updatedBy : INT (FK)

## ProfessionalSchedules
- ScheduleId: INT IDENTITY (1,1) (PK)
- professionalId: INT (FK)
- dia: VARCHAR()
- hora inicio: TIME
- hora final: TIME
- createdAt: DATETIME2
- updatedAt: DATETIME2
- updatedBy : INT (FK)

## TODO CREAR UN INDICE PARA ProfessionalSchedules
==============================================================
|        					Contact Info                      |                                     
==============================================================

## ContactTypes (Telefono, email)
- contactTypeId: INT IDENTITY (1,1) (PK)
- contactTypeName: VARCHAR (50)
- isActive : BIT
- createdAt: DATETIME2
- updatedAt: DATETIME2
- updatedBy : INT (FK)

## Contacts
- contactId: INT IDENTITY (1,1) (PK)
- contactTypeId: INT (FK)
- userId : INT (FK)
- contactValue: VARCHAR (100)  
- isActive : BIT
- createdAt: DATETIME2
- updatedAt: DATETIME2
- updatedBy : INT (FK)


==============================================================
|        			 Clinics and appointments                |                                     
==============================================================
## Clinics
- clinicId: INT IDENTITY (1,1) (PK)
- clinicName: VARCHAR(75)
- createdAt : DATETIME2
- isActive : BIT 
- updatedAt : DATETIME2
- updatedBy : INT (FK)

## ClinicsAddresses
- clinicAddressId: INT IDENTITY (1,1) (PK) 
- clinicId: INT (FK) 
- addressId : INT (FK)	 
- isActive : BIT 
- createdAt: DATETIME2 
- updatedAt: DATETIME2 
- updatedBy : INT (FK) 

## Specialties
- specialtyId: INT IDENTITY (1,1) (PK) 
- specialtyName: Varchar(31)

## Services 
- serviceId : INT IDENTITY (1,1) (PK) 
- serviceName : VARCHAR(63)
- durationMinutes: INT
- clinicId: INT (FK)
- specialtyId: INT (FK)  
- isActive : BIT 
- createdAt: DATETIME2 
- updatedAt: DATETIME2 
- updatedBy : INT (FK) 

## AppointmentsTypes (reservada, atendida, ausente, cancelada o reprogramada)
- AppointmentTypeId: INT IDENTITY (1,1) (PK)
- AppointmentTypeName: VARCHAR(12) 

## Appointments
- appointmenId: BIGINT IDENTITY (1,1) (PK)
- clientId: INT (FK) - usersId
- proffessionalId: INT (FK) - usersId
- clinicId :  INT (FK)
- appointmentDescription: VARCHAR(MAX)
- appointmentResult: VARCHAR(MAX) - null
- appointmentStart: DATETIME2
- appointmentFinish: DATETIME2
- AppointmentTypeId: INT(FK)
- createdAt: DATETIME2
- updatedAt: DATETIME2
- updatedBy : INT (FK)

## ServicesPerAppointments
- ServicePerAppointmentId: BIGINT IDENTITY (1,1) (PK)
- appointmenId: BIGINT (FK)
- serviceId: INT

==============================================================
|        					logs              	 	         |                                     
==============================================================
## FUNCION: LOG PATTERN y las sesiones a la pagina web fin xD

## sessions
- sessionId : INT AUTO_INCREMENT (PK)
- userId : INT(FK)
- sessionToken : VARCHAR(100)
- creadetAt : TIMESTAMP

## eventsTypes
- eventTypeId : INT AUTO_INCREMENT (PK)
- name : VARCHAR(50)
- description : VARCHAR(150)

## dataObjects
- dataObjectId : INT AUTO_INCREMENT(PK)
- name : VARCHAR(50)
- description : VARCHAR(100)

## severities
- severityId : INT AUTO_INCREMENT (PK)
- name : VARCHAR(50)
- description : VARCHAR(100)

## usersLogs
- logId : INT AUTO_INCREMENT(PK)
- eventType : INT(FK)
- dataObjectId : INT(FK)
- sessionId : INT(FK)
- description : VARCHAR(255)
- creadetAt : TIMESTAMP
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