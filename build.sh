#!/usr/bin/env bash

set -euxo pipefail

rm -rf dist
mkdir -p dist

pages=(conversation)

for page in "${pages[@]}"; do
	./node_modules/.bin/esbuild \
		src/frontend/pages/$page/client.ts \
		--bundle --minify --sourcemap --outfile=dist/$page.js
done

cp src/frontend/styles.css dist/styles.css
