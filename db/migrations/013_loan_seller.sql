-- Quién originó el préstamo, que no es quién armó la emisión.
--
-- LA CONFUSIÓN QUE ESTO DESHACE
--
-- Todo el análisis de "emisoras" viene atribuyéndole a BANK o a BBCMS lo que
-- hicieron sus vendedores. Un deal BANK agrupa préstamos originados por Bank of
-- America, Morgan Stanley y Wells Fargo: el shelf es el empaquetador, no el
-- suscriptor. Decir "BANK suscribe mejor" es como felicitar a la caja por lo
-- que hizo la fábrica.
--
-- POR QUÉ ESTA VARIABLE Y NO OTRO CONFUNDIDO MÁS
--
-- Los nueve ataques anteriores fueron defensivos: cada uno preguntaba "¿esto es
-- un artefacto?" y la respuesta era "no". Nueve "no" no hacen un "sí".
--
-- El vendedor es distinto porque puede CONFIRMAR el efecto. El mismo vendedor
-- coloca en varias emisiones, así que el diseño queda cruzado sin que nadie lo
-- diseñe: Wells Fargo vende hacia BANK (SIR 0,42) y hacia su propio shelf
-- (1,20). Si el vendedor manda, fijarlo tiene que aplanar esa diferencia. Si el
-- shelf manda, no.
--
-- LO QUE PUEDE SALIR MAL
--
-- Que la columna no exista en la mayoría de los Annex A. `columnMap` ya sabía
-- que "Mortgage Loan Seller" aparece en 9 filings —figuraba como exclusión de
-- `loan_amount`— pero nueve de 150 no alcanza para nada. La cobertura hay que
-- medirla antes de correr cualquier análisis encima, y si es baja la respuesta
-- correcta es "no se puede saber con este corpus".

ALTER TABLE corpus.loans
  ADD COLUMN IF NOT EXISTS loan_seller TEXT;

CREATE INDEX IF NOT EXISTS loans_seller_idx ON corpus.loans (loan_seller);

COMMENT ON COLUMN corpus.loans.loan_seller IS
  'Vendedor del préstamo según el Annex A. Es el originador; la emisora es el vehículo que lo empaqueta. Un vendedor coloca en varias emisiones, lo que hace identificable la pregunta "¿shelf o suscriptor?".';
