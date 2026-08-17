-- Quién administra cada trust.
--
-- LA PREGUNTA QUE ESTO PERMITE HACER
--
-- Ajustado por añada y por tercil de DSCR, BANK transfiere a special servicing
-- 4 veces menos que BBCMS (SIR 0,39 contra 1,60, intervalos que no se pisan).
-- Eso sobrevivió cinco intentos de matarlo: el join, la población listada, el
-- formato, los filtros, y el valor crudo en veinte emisiones.
--
-- Pero el SIR correlaciona 0,73 con la cobertura del NOI, y esa correlación NO
-- puede ser causal: el numerador sale de la tabla de morosidad, que pega al
-- 97,7% y no depende del NOI para nada. Una correlación real sin mecanismo pide
-- una causa común.
--
-- El administrador maestro arma LAS DOS tablas del informe. Si uno publica el
-- NOI sin período Y lista menos préstamos como morosos, las dos cosas se mueven
-- juntas sin causarse. BANK usa Trimont; Benchmark usa Midland.
--
-- Si es eso, "BANK suscribe mejor" es "Trimont reporta distinto" — el hallazgo
-- cambia de sujeto y de importancia.
--
-- LO QUE ESTA TABLA PUEDE NO PODER RESPONDER
--
-- Si cada shelf usa un administrador distinto y ningún administrador aparece en
-- dos shelves, emisora y administrador son la misma columna con dos nombres y
-- ningún dato del corpus las separa. Por eso lo primero que hay que mirar no es
-- el resultado sino la tabla cruzada: si no hay celdas fuera de la diagonal, la
-- pregunta no se puede hacer y hay que decirlo en vez de responderla igual.

ALTER TABLE corpus.servicer_reports
  ADD COLUMN IF NOT EXISTS master_servicer  TEXT,
  ADD COLUMN IF NOT EXISTS special_servicer TEXT;

CREATE INDEX IF NOT EXISTS servicer_reports_master_idx
  ON corpus.servicer_reports (master_servicer);

COMMENT ON COLUMN corpus.servicer_reports.master_servicer IS
  'Administrador maestro según la carátula del 10-D. Arma la tabla de NOI y la de morosidad: es el candidato a causa común de que las dos degraden juntas.';
