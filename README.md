# financials-playground

Corpus de préstamos comerciales inmobiliarios construido desde documentos
públicos de la SEC, con las herramientas para interrogarlo y para intentar
demostrar que está mal.

219 emisiones de CMBS · 10.400 préstamos · 94 métricas · 1.829 préstamos con
desempeño posterior al cierre.

---

## Qué hay acá

```
financials-playground/
├── docs/
│   ├── hallazgo-suscripcion.md     El resultado: crecimiento proyectado contra
│   │                               entregado por añada, con sus controles y sus
│   │                               agujeros. Empezá por acá.
│   ├── taxonomia-cre.md            94 métricas con definición, ambigüedades y el
│   │                               incidente que motivó cada distinción.
│   │                               Generado: npm run taxonomy -- --write
│   ├── arquitectura-propia.md      Decisiones de diseño y qué se descartó
│   └── lev-referencia-tecnica.md   Referencia de la API de Lev, del período en
│                                   que el proyecto iba a integrarse con ellos
│
├── harvest/                        Cosecha desde SEC EDGAR
│   ├── edgar/                      Cliente con las reglas de SEC, descubrimiento
│   │                               de Annex A (FWP) y de informes del servicer (10-D)
│   ├── parse/                      Tablas HTML y xlsx · informe del servicer
│   ├── normalize/                  Mapeo de columnas → observations con provenance
│   ├── batch.ts                    Cosecha en lote, reanudable
│   └── *.test.ts                   177 checks offline
│
└── db/                             Corpus en Postgres
    ├── migrations/                 001 corpus · 002 desempeño · 003-004 vistas
    ├── corpus.ts                   Escritura, lectura, promoción a facts
    ├── identities.ts               Verificación aritmética del mapeo
    ├── outcomes.ts                 Suscripción contra resultado
    ├── challenge.ts                Falsificación de hallazgos de originación
    └── explain.ts                  De qué columna salió cada número
```

---

## Arranque

```bash
npm install
npm run db:up
npm run db:migrate

export SEC_USER_AGENT="Tu Nombre tu@email.com"   # o ponelo en .env
npm run harvest:batch -- --limit 100
```

`SEC_USER_AGENT` no es una credencial: EDGAR es público y gratis, no hay cuenta
ni API key. La SEC exige que todo cliente automatizado se identifique con nombre
y email para poder avisarte si tu script se descontrola, en vez de bloquear el
rango de IPs. Sin eso devuelve 403.

Después:

```bash
npm run db:analyze         # distribuciones por tipo de activo
npm run db:identities      # ¿el mapeo es correcto?
npm run db:performance     # NOI real posterior al cierre, desde los 10-D
npm run db:outcomes        # proyectado contra entregado, por añada
npm run db:challenge       # intentos de falsear los hallazgos
```

---

## De dónde sale el dato

Todo de EDGAR, sin fuentes pagas.

| Qué | Dónde | Formulario |
|---|---|---|
| Suscripción e histórico al cierre | Annex A | FWP |
| NOI real posterior al cierre | EX-99.1 del reporte mensual | 10-D |

El Annex A publica, por préstamo: el NOI que el suscriptor proyectó, hasta cuatro
añadas de NOI histórico, tres LTV según denominador, dos DSCR, siete saldos y
unas ciento cincuenta columnas más. El 10-D publica lo que la propiedad produjo
después.

---

## La parte que no es obvia

Los datos son públicos: cualquiera baja los mismos archivos. Lo que cuesta es
interpretarlos, y el documento no declara sus propias convenciones.

**Un Annex A publica siete saldos del mismo préstamo.** Los ratios se calculan
contra *trust + pari passu no-trust*, no contra la columna que dice "Balance".
Usar la equivocada da debt yields de 3947%.

**El servicio de deuda es el de la nota del trust; el DSCR, el del préstamo
entero.** Hay que escalarlo por saldo antes de dividir.

**Un préstamo con período de solo intereses tiene dos servicios de deuda**, y el
DSCR publicado usa el menor.

**"0.00" con fechas vacías significa no reportado**, no cero.

Cada una de esas está documentada en `docs/taxonomia-cre.md` junto al incidente
que la reveló, porque ninguna se dedujo leyendo: todas salieron de que un número
no cerraba.

---

## Cómo se verifica

El corpus se verifica contra sí mismo. El emisor publica ratios que tienen que
ser consistentes con las columnas de las que se derivan, y cada columna se mapea
de forma independiente. Si columnas mapeadas por separado satisfacen las
relaciones que el emisor usó para calcularlas, el mapeo es correcto.

```
npm run db:identities
```

| identidad | cierra |
|---|---|
| DSCR (NCF) = NCF / servicio de deuda | 95% |
| DSCR (NOI) = NOI suscrito / servicio de deuda | 95% |
| NCF = NOI − reposición − TI/LC | 100% |
| Debt yield = NOI suscrito / saldo | 99% |
| LTV = saldo / tasación | 99% |

No necesita ninguna fuente externa, y detecta la clase de error que ninguna
métrica mirada sola delata.

Además, cada análisis intenta falsear su propio resultado antes de reportarlo:
`db:challenge` y los bloques de control de `db:outcomes` tienen los umbrales
fijados en el código *antes* de ver los números. Varios hallazgos se cayeron ahí
—están registrados en los comentarios, con lo que los reemplazó—.

---

## Lo que está roto y lo sabemos

- **560 préstamos** de las añadas 2020-2022 no pegan entre el informe del
  servicer y el Annex A. El parser anda; el identificador no matchea.
- **67 préstamos sin tipo de propiedad** mapeado.
- **Las identidades no corren solas** después de cosechar.
- Tres emisiones tienen el Annex A en un formato que todavía no manejamos.

---

## Tests

```bash
npm run test:all      # 177 checks, todos offline
```

Los fixtures son documentos reales recortados, no sintéticos. Un test que pasa
sobre datos inventados no dice nada sobre el próximo Annex A.

---

## Restricciones

- **Node ≥ 20.3.** El piso lo pone `AbortSignal.any()`.
- **Máximo 10 pedidos por segundo a SEC.** El cliente limita a 8 con margen.
- **Una migración aplicada no se toca.** Los cambios van en un archivo nuevo;
  editar una vieja obliga a `db:reset`, que borra el corpus.
