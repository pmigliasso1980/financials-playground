-- El Pros ID crudo en la tabla de morosidad.
--
-- POR QUÉ APARECE AHORA
--
-- El lote informó 341 préstamos morosos persistidos y la tabla tenía 282, sobre
-- 349 filas parseadas. Tres números para lo que parecía una sola cosa:
--
--   349  filas de morosidad en el 10-D
--   341  filas que encontraron su préstamo en el corpus   (join: 97,7%)
--   282  filas distintas en la tabla                      (59 colapsadas)
--
-- Las 59 no se perdieron en el join: se perdieron en el ON CONFLICT. Dos filas
-- del informe que caen sobre el mismo `loan_id` porque `loanInt()` toma los
-- dígitos iniciales del Pros ID, y el servicer numera los tramos pari passu
-- como `1`, `1A`, `1B`. Colapsarlos es correcto —un préstamo, varios tramos—
-- pero sin guardar el identificador crudo no hay forma de demostrarlo sin
-- volver a bajar el documento.
--
-- `corpus.performance` ya guarda `pros_id` con exactamente ese argumento en su
-- comentario. La tabla de morosidad se creó sin él y por eso una diferencia de
-- 59 filas quedó indistinguible de un join roto.
--
-- LA CONSTRAINT NO CAMBIA
--
-- Sigue siendo UNIQUE (report_accession, loan_id): el estado de pago es del
-- préstamo, no del tramo, y dos tramos del mismo préstamo no son dos morosos.
-- `pros_id` queda como el último tramo visto —sirve para auditar, no para
-- identificar—. Meterlo en la clave inflaría el numerador de morosidad con
-- tramos, que es el error opuesto y peor.

ALTER TABLE corpus.delinquency
  ADD COLUMN IF NOT EXISTS pros_id TEXT;

COMMENT ON COLUMN corpus.delinquency.pros_id IS
  'Identificador tal como lo publica el servicer, antes de normalizar. Auditoría del join: si dos filas del informe colapsan en un loan_id, acá queda el último tramo visto.';
