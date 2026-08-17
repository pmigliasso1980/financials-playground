-- Índice en la clave foránea que faltaba.
--
-- POR QUÉ UNA RECOSECHA TARDABA HORAS
--
-- `corpus.facts.observation_id` referencia a `corpus.observations(id)` con
-- ON DELETE SET NULL, y no tenía índice.
--
-- Postgres no indexa automáticamente el lado que referencia de una foreign key
-- —solo el lado referenciado, por la PK—. Sin índice, cada observation borrada
-- obliga a un Seq Scan completo de `facts` para encontrar las filas que la
-- apuntan y ponerlas en NULL.
--
-- Una recosecha con `--refresh-stale` borra el filing entero antes de reescribir
-- (ON DELETE CASCADE), así que sobre un corpus de ~600.000 observations y
-- ~500.000 facts eso son 600.000 escaneos secuenciales de medio millón de filas.
-- El lote pasó de 18 minutos a horas cuando el corpus creció, y el tiempo no
-- estaba en la red, ni en el parseo, ni en las inserciones: estaba acá.
--
-- CÓMO SE DETECTA ESTO EN GENERAL
--
-- Toda columna que sea el lado referenciado de un DELETE CASCADE o SET NULL
-- necesita índice. Es un caso donde el costo no aparece con datos de prueba
-- —con mil filas el Seq Scan es instantáneo— y explota de golpe cuando el corpus
-- llega a cierto tamaño. Los otros dos FK del esquema (loans.accession,
-- observations.loan_id, facts.loan_id) sí tenían índice; este se pasó por alto
-- porque no se usa en ninguna consulta de lectura.

CREATE INDEX IF NOT EXISTS facts_observation_idx
  ON corpus.facts (observation_id);

COMMENT ON INDEX corpus.facts_observation_idx IS
  'No sirve para leer: existe para que el ON DELETE SET NULL de observations no haga un Seq Scan por fila borrada.';
