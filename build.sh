#!/usr/bin/env bash

set -euxo pipefail

pages=(index chat)

for page in "${pages[@]}"; do
	./node_modules/.bin/esbuild \
		src/frontend/pages/$page/client.ts \
		--bundle --minify --sourcemap --outfile=dist/$page.js
done
