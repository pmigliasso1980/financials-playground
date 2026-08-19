/**
 * The state, as a two-letter code.
 *
 * WHY IT EXISTS
 *
 * The monitor found **1,585 loans with an invalid state: 16.4% of the corpus**.
 * Of those, 795 had the name written out in full —"New York", "California",
 * "Texas"— because some issuers publish it that way and the harvester stored the
 * raw text without normalising.
 *
 * Those loans were invisible to EVERY `/comps` query, which filters by
 * two-letter code. They did not show up in the state, nor the region, nor the
 * national query. And they left no trace: a filter that does not match does not
 * complain.
 *
 * It turned up sideways, while asking why industrial in California returned 9
 * comparables and the entire Pacific division also 9. New York has 1,839 loans
 * with a code and 206 more written "New York": 11% the product could not see.
 *
 * WHAT THIS TABLE DOES NOT FIX
 *
 * The other 790 have an EMPTY state, and there is nothing there to map. The
 * suspicion —to be verified, not assumed— is that they are multi-state
 * portfolios, the same phenomenon that explains most of the loans with no
 * property type: a loan over properties in five states does not have ONE state,
 * and the Annex A leaves the cell blank or writes "Various".
 *
 * If that is what it is, the right answer is not to fill it in but to treat it
 * as what it is.
 *
 * ONLY THE SAFE CASES ARE MAPPED
 *
 * Full names, territories and abbreviations with a period. No partial matches
 * and no edit distances: a wrongly guessed state puts a loan in the wrong
 * market, and that is worse than leaving it out —where at least the monitor
 * counts it. Anything not in the table stays invalid and keeps showing up in the
 * alert.
 */

/** The fifty plus DC, by full name. */
const BY_NAME: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY",
  /**
   * DC does NOT rely on coming after "washington" —object key order is not
   * guaranteed— so the variants are listed explicitly. "Washington" on its own
   * is the state; the district is always written differently.
   */
  "district of columbia": "DC", "washington dc": "DC", "washington, d.c.": "DC",
  "washington d.c.": "DC",
};

/**
 * Territories, which I nearly swallowed.
 *
 * The first version of `STATE_CODES` was built only from the fifty states plus
 * DC, so `normalizeState("PR")` would have returned null and the Puerto Rico
 * loans —which work today— would have disappeared from the product. A fix that
 * breaks something that worked, which is exactly what this file exists to
 * prevent.
 *
 * Puerto Rico has a real CMBS market; the others are rare but cost one line, and
 * their absence would cost an invisible loan.
 */
const TERRITORIES: Record<string, string> = {
  "puerto rico": "PR", "virgin islands": "VI", "u.s. virgin islands": "VI",
  guam: "GU", "american samoa": "AS", "northern mariana islands": "MP",
};

/** Abbreviations with a period, as they appear in the Annex A documents. */
const ABBREVIATIONS: Record<string, string> = {
  "calif.": "CA", "conn.": "CT", "fla.": "FL", "ill.": "IL", "ind.": "IN",
  "kans.": "KS", "mass.": "MA", "mich.": "MI", "minn.": "MN", "miss.": "MS",
  "n.c.": "NC", "n.j.": "NJ", "n.m.": "NM", "n.y.": "NY", "okla.": "OK",
  "penn.": "PA", "penna.": "PA", "tenn.": "TN", "tex.": "TX", "va.": "VA",
  "wash.": "WA", "wis.": "WI", "wisc.": "WI", "d.c.": "DC",
};

/** The valid codes, so that any two letters are not accepted. */
export const STATE_CODES = new Set([
  ...Object.values(BY_NAME),
  ...Object.values(TERRITORIES),
]);

/**
 * Returns the two-letter code, or `null` when it cannot be stated which one it
 * is.
 *
 * `null` is an answer: the loan ends up counted in the monitor's alert instead
 * of assigned to an invented state.
 */
export function normalizeState(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const clean = raw.trim().replace(/\s+/g, " ");
  if (!clean) return null;

  /** Already a code: accepted only if it really exists. */
  if (/^[A-Za-z]{2}$/.test(clean)) {
    const code = clean.toUpperCase();
    return STATE_CODES.has(code) ? code : null;
  }

  const key = clean.toLowerCase();
  return BY_NAME[key] ?? TERRITORIES[key] ?? ABBREVIATIONS[key] ?? null;
}

/**
 * The same mapping as a SQL CASE, for `db:fix-states`, which repairs what has
 * already been harvested without downloading the documents again.
 *
 * It is generated from the SAME table rather than written by hand: two lists of
 * fifty entries that have to be kept in sync diverge on the first correction
 * made to only one of them, and this session has already shown that three times.
 */
export function sqlCase(column = "state"): string {
  const branches = [
    ...Object.entries(BY_NAME),
    ...Object.entries(TERRITORIES),
    ...Object.entries(ABBREVIATIONS),
  ]
    .map(([name, code]) => `      WHEN lower(btrim(${column})) = ${sqlLiteral(name)} THEN '${code}'`)
    .join("\n");
  return `CASE\n      WHEN btrim(${column}) ~ '^[A-Za-z]{2}$' THEN upper(btrim(${column}))\n${branches}\n      ELSE NULL\n    END`;
}

const sqlLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;
