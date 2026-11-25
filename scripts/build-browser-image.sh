#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Resolve the channel on every invocation, before Docker can reuse a layer.
if ! chrome_version=$(curl --proto '=https' --proto-redir '=https' --fail --silent --show-error \
  --location --retry 3 --connect-timeout 15 --max-time 60 \
  https://googlechromelabs.github.io/chrome-for-testing/LATEST_RELEASE_STABLE); then
  echo 'Could not resolve the Chrome for Testing Stable release.' >&2
  exit 1
fi
if [[ ! "$chrome_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo 'Chrome for Testing returned an invalid Stable version.' >&2
  exit 1
fi

printf 'Building browser image with Chrome for Testing Stable %s\n' "$chrome_version"
exec docker build \
  --build-arg "AGENT_IMAGE=${AGENTBOX_BROWSER_BASE_IMAGE:-agentbox-agent:latest}" \
  --build-arg "CHROME_VERSION=$chrome_version" \
  -t "${AGENTBOX_BROWSER_IMAGE:-agentbox-agent:browser}" images/browser
