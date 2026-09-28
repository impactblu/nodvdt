#!/bin/sh
# Vercel build step (see vercel.json): check the data, then assemble the
# public site from site/ + data/ + datasheets/ into _site/.
# The collector code and everything else in the repository stay private.
set -e

if command -v python3 >/dev/null 2>&1; then
  (cd collector && python3 -m collector validate --root ..)
else
  echo "python3 not available in this build image; skipping data validation"
fi

rm -rf _site
mkdir -p _site
cp -R site/. _site/
cp -R data datasheets _site/
echo "Site assembled: $(find _site -type f | wc -l) files"
