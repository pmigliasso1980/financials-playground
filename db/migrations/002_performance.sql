-- Desempeño post-originación, tomado de los 10-D.
--
-- POR QUÉ ES UNA TABLA APARTE Y NO MÁS observations
--
-- Las observations del Annex A describen el préstamo al cierre: son una foto,
-- y por eso su clave es (préstamo, métrica, header de origen). El desempeño es
-- una serie: el mismo préstamo tiene un NOI por período reportado, y el período
-- es parte de la identidad del dato, no un atributo suelto.
--
-- Meterlo en observations obligaría a codificar el período dentro del
-- metric_key —"noi_real_2025"— y eso rompe el catálogo de métricas, que es
-- justamente la pieza que más nos costó ordenar.
--
-- DÓNDE ESTA TABLA SE APARTA DE LA CONVENCIÓN DEL CORPUS
--
-- En corpus.observations todo valor va como TEXT, porque un Annex A mezcla
-- monedas, porcentajes y fechas en la misma columna y el tipo lo determina la
-- métrica. Acá no: annualized_noi es siempre dinero anualizado, con una sola
-- interpretación posible. Guardarlo como NUMERIC evita castear en cada consulta
-- y permite que la base valide lo que entra.

-- ---------------------------------------------------------------------------
-- Informes del servicer
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS corpus.servicer_reports (
  accession        TEXT PRIMARY KEY,
  cik              TEXT        NOT NULL,
  company_name     TEXT        NOT NULL,
  filed_at         DATE,
  -- Fecha de distribución que reporta el 10-D.
  period_of_report DATE,
  file_name        TEXT        NOT NULL,
  file_url         TEXT        NOT NULL,

  harvested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  stats            JSONB       NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE corpus.servicer_reports IS
  'EX-99.1 de los 10-D. Uno por trust y mes; normalmente cosechamos el de abril, que es cuando el ejercicio anterior ya está consolidado.';

CREATE INDEX IF NOT EXISTS servicer_reports_cik_idx ON corpus.servicer_reports (cik);

-- ---------------------------------------------------------------------------
-- NOI real por préstamo
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS corpus.performance (
  id               BIGSERIAL PRIMARY KEY,
  report_accession TEXT    NOT NULL REFERENCES corpus.servicer_reports(accession) ON DELETE CASCADE,
  loan_id          BIGINT  NOT NULL REFERENCES corpus.loans(id) ON DELETE CASCADE,

  -- Identificador tal como lo publica el servicer, antes de normalizar.
  -- Se guarda para poder auditar el join sin volver a bajar el documento.
  pros_id          TEXT    NOT NULL,

  annualized_noi   NUMERIC NOT NULL,
  noi_start        DATE    NOT NULL,
  noi_end          DATE    NOT NULL,
  period_days      INTEGER NOT NULL,
  -- False significa que el valor viene extrapolado de un período parcial.
  -- Por política del harvester hoy solo entran los completos, pero la columna
  -- existe para poder aflojar el criterio sin migrar.
  is_full_year     BOOLEAN NOT NULL,
  -- Cuántos tramos pari passu reportaron este mismo préstamo.
  tranches         INTEGER NOT NULL DEFAULT 1,

  UNIQUE (report_accession, loan_id)
);

CREATE INDEX IF NOT EXISTS performance_loan_idx ON corpus.performance (loan_id);
CREATE INDEX IF NOT EXISTS performance_end_idx  ON corpus.performance (noi_end);

-- ---------------------------------------------------------------------------
-- La vista que hace la pregunta de Griffin
-- ---------------------------------------------------------------------------

-- Tres cifras por préstamo: lo que la propiedad producía, lo que el suscriptor
-- dijo que iba a producir, y lo que produjo.
--
-- El caso que motivó incluir las tres: Benchmark 2024-V7, préstamo 8. Suscrito
-- 3,4% POR DEBAJO del histórico —conservador según cualquier medición de
-- originación— y el NOI real cayó 62%. Mirando solo suscrito contra histórico
-- ese préstamo aparecía del lado prudente de la distribución.
-- La vista de resultados vive en 003_outcomes_view.sql.
--
-- Estuvo acá y la editamos in situ para agregarle columnas. Como `db:migrate`
-- solo aplica lo pendiente, el único modo de que el cambio tomara efecto era
-- `db:reset`, que borra el corpus. Se hizo, y la recosecha falló porque la SEC
-- había empezado a estrangular. Una migración aplicada no se toca.
