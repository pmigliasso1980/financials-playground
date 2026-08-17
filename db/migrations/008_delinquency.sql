-- Estado de pago y special servicing, del bloque "Delinquency Loan Detail".
--
-- POR QUÉ ESTA VARIABLE
--
-- El crecimiento del NOI tiene un error estándar de 2,4 puntos por añada y
-- ninguna añada del corpus es distinguible de otra (`db:power`). Esta es un
-- conteo: con ~400 préstamos por añada el piso de ruido baja a ~3 puntos
-- porcentuales, sobre tasas base observadas de 0% a 3%. Es la primera variable
-- del proyecto donde el efecto esperado supera el ruido con margen.
--
-- LA TABLA LISTA SOLO LOS AFECTADOS
--
-- El 10-D no publica el estado de cada préstamo: publica los que están morosos o
-- en special servicing. Las filas son el numerador; el denominador es el pool
-- del Annex A, que ya está en `corpus.loans`. No hace falta parsear los sanos.
--
-- ATRASO Y SPECIAL SERVICING NO SON LO MISMO
--
-- Benchmark 2020-B16 tiene un préstamo transferido a special servicing en enero
-- que paga al día: 0 meses de atraso. La transferencia es la señal temprana; el
-- atraso es el síntoma tardío. Se guardan las dos porque miden cosas distintas.
--
-- `months_delinquent` y `paid_through` son el mismo hecho por dos caminos —los
-- meses tienen que ser ≈ (fin del período − paid through)/30— y están las dos
-- para poder contrastarlas. Es la clase de verificación que en el Annex A
-- descubrimos tarde.

CREATE TABLE IF NOT EXISTS corpus.delinquency (
  id                BIGSERIAL PRIMARY KEY,
  report_accession  TEXT    NOT NULL,
  loan_id           BIGINT  NOT NULL REFERENCES corpus.loans(id) ON DELETE CASCADE,
  period            DATE,
  paid_through      DATE,
  months_delinquent NUMERIC,
  status            TEXT,
  transfer_date     DATE,
  foreclosure_date  DATE,
  reo_date          DATE,
  UNIQUE (report_accession, loan_id)
);

-- El lado que referencia de un CASCADE necesita índice: sin él cada préstamo
-- borrado en una recosecha dispara un Seq Scan. Ya pasó con facts.observation_id
-- y costó que un lote pasara de minutos a horas.
CREATE INDEX IF NOT EXISTS delinquency_loan_idx ON corpus.delinquency (loan_id);

COMMENT ON TABLE corpus.delinquency IS
  'Préstamos morosos o en special servicing según el 10-D. Las filas son el numerador; el denominador es el pool en corpus.loans.';
