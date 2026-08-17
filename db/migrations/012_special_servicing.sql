-- De qué bloque del 10-D salió cada fila.
--
-- EL EVENTO ESTABA EN OTRA TABLA
--
-- `corpus.delinquency` se llenaba solo desde el bloque "Delinquency Loan
-- Detail". Pero el 10-D trae además "Specially Serviced Loan Detail", con su
-- propia columna `Servicing Transfer Date`, y un préstamo puede estar en special
-- servicing PAGANDO AL DÍA — en cuyo caso aparece ahí y no entre los morosos.
--
-- BANK 2021-BNK36 dice "No delinquent loans this period" y tiene al Pros ID 71
-- —multifamily en Illinois, transferido el 12/02/2025— en el otro bloque. El
-- pipeline lo contaba como cero eventos.
--
-- POR QUÉ IMPORTA MÁS DE LO QUE PARECE
--
-- La brecha "BANK transfiere 4 veces menos que BBCMS" sobrevivió ocho intentos
-- de matarla: cobertura del join, población listada, formato, filtros, valor
-- crudo en veinte emisiones, administrador maestro, administrador especial y
-- composición por tipo de propiedad × añada.
--
-- Los ocho atacaron el denominador o los controles. Ninguno preguntó si el
-- NUMERADOR estaba completo. Si un shelf tiene préstamos que entran a special
-- servicing antes de dejar de pagar y otro no, la diferencia entre sus tasas
-- mide qué bloque llenó cada administrador y no quién suscribe mejor.
--
-- LA CONSTRAINT NO CAMBIA
--
-- Sigue siendo UNIQUE (report_accession, loan_id): un préstamo que aparece en
-- los dos bloques es un préstamo, no dos. `source` registra dónde se lo vio, y
-- el upsert desde el bloque especial NO pisa `months_delinquent` —ese dato solo
-- existe en el bloque de morosidad—.

ALTER TABLE corpus.delinquency
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS resolution_code TEXT;

COMMENT ON COLUMN corpus.delinquency.source IS
  'De qué bloque del 10-D salió: delinquency, special, o ambos. Sin esto, "no hay evento" y "el evento estaba en la tabla que no leíamos" son la misma fila ausente.';

-- Las filas ya cargadas vienen todas del bloque de morosidad.
UPDATE corpus.delinquency SET source = 'delinquency' WHERE source IS NULL;
