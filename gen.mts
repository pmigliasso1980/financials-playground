import { casoSql } from "./harvest/normalize/estados.js";
import { writeFile } from "node:fs/promises";

const cabecera = [
  "-- Normaliza el estado a código de dos letras en lo ya cosechado.",
  "--",
  "-- El monitor encontró 1.585 préstamos con estado inválido: el 16,4% del corpus,",
  "-- invisible para toda consulta de /comps porque filtra por código. De ésos, 795",
  '-- tienen el nombre completo —"New York", "California"— porque algunos emisores lo',
  "-- publican así y el harvester guardaba el texto crudo sin normalizar.",
  "--",
  "-- El harvester ya normaliza al escribir (harvest/normalize/estados.ts), pero",
  "-- recosechar 233 filings tarda horas por el límite de velocidad de SEC y el mapeo",
  "-- es determinista. Esto arregla lo existente sin volver a bajar nada.",
  "--",
  "-- El CASE se generó DESDE la misma tabla de TypeScript, no se escribió a mano: dos",
  "-- listas de cincuenta entradas divergen en la primera corrección que se hace en una",
  "-- sola.",
  "--",
  "-- Lo que no está en la tabla queda en NULL y sigue apareciendo en la alerta del",
  "-- monitor. Un estado mal adivinado pone un préstamo en el mercado equivocado, y eso",
  "-- es peor que dejarlo afuera.",
  "",
  "UPDATE corpus.loans",
  "   SET state = " + casoSql(),
  " WHERE state IS NOT NULL",
  "   AND btrim(state) !~ '^[A-Z]{2}$';",
  "",
].join("\n");

await writeFile("db/migrations/014_normalizar_estado.sql", cabecera, "utf8");
console.log("escrito · ramas del CASE:", (casoSql().match(/WHEN/g) ?? []).length);
