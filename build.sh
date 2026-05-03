#!/usr/bin/env bash

set -euxo pipefail

rm -rf dist
mkdir -p dist

for entry in src/frontend/pages/*/client.tsx; do
	[ -e "$entry" ] || continue
	page=$(basename "$(dirname "$entry")")
	./node_modules/.bin/esbuild \
		"$entry" \
		--bundle --minify --sourcemap \
		--format=esm --target=es2022 \
		--jsx=automatic --jsx-import-source=react \
		--define:process.env.NODE_ENV='"production"' \
		--legal-comments=none \
		--outfile="dist/$page.js"
done

cp src/frontend/styles.css dist/styles.css
