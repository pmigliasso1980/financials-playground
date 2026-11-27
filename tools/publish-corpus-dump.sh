#!/bin/bash
# One-time seed for the corpus-weekly workflow: dumps the local Docker database
# and publishes it (with the monitor snapshot) as the `corpus-db` release.
# Needs: Docker with financials-postgres running, and the GitHub CLI (`gh auth login`).
set -e
cd "$(dirname "$0")/.."
mkdir -p state
docker exec financials-postgres pg_dump -U financials -d financials --no-owner | gzip -9 > state/corpus.sql.gz
cp -f out/health.json state/health.json 2>/dev/null || true
gh release view corpus-db >/dev/null 2>&1 || \
  gh release create corpus-db --title "corpus-db (state)" --notes "Database dump and monitor snapshot used by corpus-weekly. Do not delete."
gh release upload corpus-db state/corpus.sql.gz state/health.json --clobber
ls -lh state/corpus.sql.gz
rm -rf state
echo "Seeded. Now set the SEC_USER_AGENT secret and run the workflow once from the Actions tab."
