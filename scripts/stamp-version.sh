#!/usr/bin/env bash
# Stamps the version from a release tag into package.json and src/version.ts.
# The repo carries 0.0.0-tagged; publish.yml runs this before it verifies and
# publishes, so the tag is the only source of the published version.
# Usage: scripts/stamp-version.sh v1.2.3   (or v1.2.3-rc.1 for a prerelease)
set -euo pipefail

tag="${1:-}"
semver='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
if [[ ! "$tag" =~ $semver ]]; then
  echo "stamp-version: '$tag' is not a release tag of the form vX.Y.Z" >&2
  exit 1
fi
version="${tag#v}"

cd "$(dirname "$0")/.."
npm version --no-git-tag-version "$version" >/dev/null
printf '%s\n' \
  '/** The published package version, stamped from the release tag. A unit test keeps it equal to package.json. */' \
  "export const KIT_VERSION = '$version'" >src/version.ts
echo "stamp-version: $version"
