-- Las celdas que el mapeo no supo interpretar, con su valor.
--
-- POR QUÉ GUARDAR LO QUE NO ENTENDEMOS
--
-- `filings.columns_unmapped` ya guardaba los ENCABEZADOS sin mapear, y eso
-- alcanzó para dos arreglos: buscando ahí apareció el nombre real de la columna
-- de identificador en las añadas 2020, y salió el ranking de columnas candidatas
-- por préstamos afectados.
--
-- Pero un encabezado solo permite adivinar. Sobre Tysons Corner Center sabemos,
-- por dos identidades independientes, que el saldo que falta vale 708.777.715:
-- el implícito por debt yield da 708.777.715 y el implícito por LTV da
-- 709.200.000, 0,06% de diferencia. Con esa cifra en la mano, encontrar la
-- columna no debería requerir leer ochenta y siete nombres y elegir el que suene
-- mejor — debería ser una comparación numérica contra las celdas de esa fila.
--
-- Eso es lo que esta tabla habilita. La diferencia práctica: durante esta sesión
-- predije tres veces de qué columna venía un problema y acerté una. Cada
-- predicción costó un ciclo de recosecha de diez minutos.
--
-- QUÉ SE GUARDA Y QUÉ NO
--
-- Solo celdas que parsean como número. Las fechas, descripciones y notas al pie
-- no sirven para reconciliar y triplicarían la tabla.
--
-- `value_num` es la magnitud tal como está impresa, sin interpretar según
-- unidad: no se convierte porcentaje a fracción ni se quita el sufijo "x". Para
-- comparar contra un valor implícito hace falta el número crudo; la
-- interpretación es justamente lo que todavía no sabemos hacer con esta columna.
--
-- EL ÍNDICE DE loan_id NO ES OPCIONAL
--
-- Es el lado que referencia de una foreign key con ON DELETE CASCADE, y Postgres
-- no lo indexa solo. Sin él, cada recosecha —que borra el filing antes de
-- reescribirlo— haría un Seq Scan completo de esta tabla por cada préstamo
-- borrado. Ya nos pasó con `facts.observation_id` y costó que un lote pasara de
-- minutos a horas.

CREATE TABLE IF NOT EXISTS corpus.unmapped_cells (
  id         BIGSERIAL PRIMARY KEY,
  loan_id    BIGINT  NOT NULL REFERENCES corpus.loans(id) ON DELETE CASCADE,
  header     TEXT    NOT NULL,
  raw_value  TEXT    NOT NULL,
  value_num  NUMERIC NOT NULL,
  UNIQUE (loan_id, header)
);

CREATE INDEX IF NOT EXISTS unmapped_cells_loan_idx
  ON corpus.unmapped_cells (loan_id);

-- El reconciliador busca "qué celda de esta fila vale ~X", así que el filtro
-- fuerte es por loan_id y después por magnitud. Este índice sirve para el
-- agregado inverso: qué encabezados aparecen con valores en cierto rango.
CREATE INDEX IF NOT EXISTS unmapped_cells_header_idx
  ON corpus.unmapped_cells (header);

COMMENT ON TABLE corpus.unmapped_cells IS
  'Celdas numéricas de columnas que el mapeo no interpretó. Existen para reconciliar valores implícitos contra columnas candidatas sin adivinar por el nombre del encabezado.';
