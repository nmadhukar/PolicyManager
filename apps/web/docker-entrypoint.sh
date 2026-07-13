#!/bin/sh
set -e

# Runtime env injection for a statically-built SPA.
# Build the image with VITE_API_BASE_URL=__API_BASE_URL__ (a sentinel); at
# container start we replace the sentinel in the built JS with the real
# API_BASE_URL env, so one image serves any environment (Coolify pattern).
: "${API_BASE_URL:=}"

if [ -n "$API_BASE_URL" ]; then
  echo "Injecting API_BASE_URL=$API_BASE_URL into web bundle"
  find /usr/share/nginx/html/assets -type f -name '*.js' -exec \
    sed -i "s|__API_BASE_URL__|$API_BASE_URL|g" {} +
fi
