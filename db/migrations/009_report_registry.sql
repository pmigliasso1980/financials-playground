-- Qué emisión cubre cada informe del servicer.
--
-- EL CONFUNDIDO QUE ESTO ARREGLA
--
-- `db:predictors` y `db:delinquency` restringen su base así:
--
--     WHERE f.accession IN (SELECT accession FROM corpus.loans
--                            JOIN corpus.performance ON ...)
--
-- con el comentario "solo emisiones que tienen informe del servicer: en las
-- demás el evento no es observable". Pero `corpus.performance` es la tabla de
-- NOI. Eso usa "pudimos parsear el NOI" como proxy de "hay informe", y las dos
-- cosas no son lo mismo: el shelf BANK publica su bloque de morosidad completo
-- —Months Delinquent, Servicing Transfer Date, Foreclosure Date— y aun así
-- queda fuera del análisis porque su NOI viene sin período utilizable.
--
-- La pregunta de morosidad nunca necesitó el NOI. Estaba pagando el costo de
-- una dependencia ajena.
--
-- POR QUÉ UNA COLUMNA Y NO UN JOIN POR CIK
--
-- El trust y su informe comparten CIK, así que el join se podría hacer sin
-- guardar nada. No se hace: `servicerBatch` inserta el CIK como
-- `String(Number(cik))` y `corpus.filings` lo guarda como viene. Dos
-- normalizaciones distintas de la misma clave es exactamente la clase de junta
-- silenciosa que ya nos costó un día con `Pros ID`. La emisión que se cosechó
-- se sabe en el momento de cosecharla; guardarla es más barato que deducirla.
--
-- POR QUÉ NULLABLE
--
-- Las filas ya cosechadas no la tienen. Se rellenan abajo por CIK —que para el
-- corpus existente alcanza— pero la columna queda nullable para que un backfill
-- incompleto se vea como NULL en vez de romper la migración. Un NULL acá es
-- "no sé de qué emisión es"; un cero sería mentira.

ALTER TABLE corpus.servicer_reports
  ADD COLUMN IF NOT EXISTS deal_accession TEXT REFERENCES corpus.filings(accession) ON DELETE CASCADE;

-- El lado que referencia de un CASCADE necesita índice propio: Postgres no lo
-- crea solo y sin él cada borrado de filing dispara un Seq Scan.
CREATE INDEX IF NOT EXISTS servicer_reports_deal_idx
  ON corpus.servicer_reports (deal_accession);

-- Backfill. `String(Number(cik))` quita ceros a la izquierda, así que se
-- comparan los dos lados como número. Solo donde hay una única emisión por CIK:
-- si un CIK tuviera dos, adivinar cuál sería inventar.
UPDATE corpus.servicer_reports sr
   SET deal_accession = f.accession
  FROM (
    SELECT cik, min(accession) AS accession
      FROM corpus.filings
     GROUP BY cik
    HAVING count(*) = 1
  ) f
 WHERE sr.deal_accession IS NULL
   AND f.cik ~ '^[0-9]+$'
   AND sr.cik ~ '^[0-9]+$'
   AND f.cik::bigint = sr.cik::bigint;

COMMENT ON COLUMN corpus.servicer_reports.deal_accession IS
  'Emisión que este informe cubre. Es el gate correcto para "el evento es observable": una emisión registrada acá tiene informe parseado, haya dado NOI o no.';
