-- ---------------------------------------------------------------------------
-- Propiedades: las filas que el harvester descartaba
-- ---------------------------------------------------------------------------
--
-- POR QUÉ
--
-- Un Annex A trae dos clases de fila: una por préstamo y una por cada propiedad
-- que lo garantiza. El harvester se quedaba con las de préstamo y contaba las de
-- propiedad para tirarlas.
--
-- Medido sobre los tres fixtures: 138 filas descartadas, 138 con estado, ciudad y
-- nombre de propiedad no vacíos. "101 45th Street, Munster, IN". "Extra Space
-- Brickell, Miami, FL". "Soho Grand Hotel, New York, NY". No era residuo.
--
-- Eso dejaba 585 préstamos sin ningún estado —los que garantizan propiedades en
-- más de uno, donde el emisor deja la celda en blanco porque no hay UN estado— y
-- por lo tanto invisibles para toda consulta de /comps. Y también perdía las
-- direcciones de los multi-propiedad que sí tienen estado guardado, que son más.
--
-- CÓMO SE ATA CADA PROPIEDAD A SU PRÉSTAMO
--
-- Por la numeración del emisor, que es consistente entre familias:
--
--   3.00 o 3   ← el préstamo
--   3.01       ← primera propiedad que lo garantiza
--   3.02       ← segunda
--
-- Verificado sobre los tres fixtures: 138 de 138 filas de propiedad tienen ID
-- decimal y su parte entera corresponde a un préstamo guardado. Ninguna quedó
-- huérfana.
--
-- Se guarda `loan_id` resuelto Y `loan_ref` crudo: si algún emisor numera distinto,
-- la fila entra igual con loan_id NULL y queda contada en vez de perdida.
--
-- LO QUE ESTA TABLA NO ES
--
-- No reemplaza a `loans`. Un préstamo sigue siendo la unidad de crédito y las
-- métricas financieras —DSCR, LTV, saldo— son del préstamo, no de cada propiedad.
-- Acá va la geografía y la identidad física, que es lo que se descartaba.

CREATE TABLE IF NOT EXISTS corpus.properties (
  id            BIGSERIAL PRIMARY KEY,
  accession     TEXT    NOT NULL REFERENCES corpus.filings(accession) ON DELETE CASCADE,

  -- Índice de la fila dentro del Annex A. Junto al accession identifica la
  -- propiedad de forma estable entre recosechas, igual que en `loans`.
  row_index     INTEGER NOT NULL,

  -- El préstamo que garantiza. NULL si el ID del emisor no se pudo resolver:
  -- preferimos una propiedad sin dueño a no guardarla.
  loan_id       BIGINT  REFERENCES corpus.loans(id) ON DELETE CASCADE,
  -- Lo que publica el emisor, crudo: "3.01". Se conserva para poder auditar.
  property_ref  TEXT,
  -- La parte entera, "3", que es la que ata. Se guarda para poder rehacer el
  -- vínculo sin volver a parsear.
  loan_ref      TEXT,

  property_name TEXT,
  address       TEXT,
  city          TEXT,
  state         TEXT,
  zip           TEXT,
  property_type TEXT,

  UNIQUE (accession, row_index)
);

CREATE INDEX IF NOT EXISTS properties_accession_idx ON corpus.properties (accession);
CREATE INDEX IF NOT EXISTS properties_loan_idx      ON corpus.properties (loan_id);
CREATE INDEX IF NOT EXISTS properties_state_idx     ON corpus.properties (state);
CREATE INDEX IF NOT EXISTS properties_type_idx      ON corpus.properties (property_type);

-- ---------------------------------------------------------------------------
-- La geografía de un préstamo, sea de una propiedad o de veinte
-- ---------------------------------------------------------------------------
--
-- El estado del préstamo si lo tiene, y si no los estados de sus propiedades.
-- Una fila por par (préstamo, estado): un préstamo con propiedades en Texas y
-- California aparece dos veces, y aparece en las dos consultas.
--
-- `origen` dice de dónde salió, porque no son lo mismo: 'prestamo' es lo que el
-- emisor puso en la fila del préstamo, 'propiedad' es lo que dedujimos de sus
-- garantías. Quien consulte puede decidir si acepta la segunda.

CREATE OR REPLACE VIEW corpus.loan_states AS
  SELECT l.id AS loan_id, l.accession, btrim(l.state) AS state, 'prestamo'::text AS origen
    FROM corpus.loans l
   WHERE l.state IS NOT NULL AND btrim(l.state) <> ''
  UNION
  SELECT p.loan_id, p.accession, btrim(p.state), 'propiedad'::text
    FROM corpus.properties p
   WHERE p.loan_id IS NOT NULL AND p.state IS NOT NULL AND btrim(p.state) <> '';
