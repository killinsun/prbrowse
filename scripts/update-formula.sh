#!/usr/bin/env bash
# Generate Formula/prbrowse.rb for killinsun/homebrew-tap after a GitHub Release.
# Usage: ./scripts/update-formula.sh v0.1.1
set -euo pipefail

VERSION="${1:?version required, e.g. v0.1.0}"
VERSION="${VERSION#v}"
REPO="killinsun/prbrowse"
BASE="https://github.com/${REPO}/releases/download/v${VERSION}"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

gh release download "v${VERSION}" -R "$REPO" -D "$tmpdir" \
  -p 'prbrowse-*.sha256'

sha() {
  local file="$1"
  awk '{print $1}' "${tmpdir}/${file}.sha256"
}

ARM_SHA="$(sha prbrowse-darwin-arm64.tar.gz)"
AMD_SHA="$(sha prbrowse-darwin-amd64.tar.gz)"
LINUX_SHA="$(sha prbrowse-linux-amd64.tar.gz)"

cat <<EOF
class Prbrowse < Formula
  desc "Browse GitHub PR review comments in a TUI"
  homepage "https://github.com/${REPO}"
  version "${VERSION}"
  license "MIT"

  depends_on "gh"

  on_macos do
    on_arm do
      url "${BASE}/prbrowse-darwin-arm64.tar.gz"
      sha256 "${ARM_SHA}"
    end
    on_intel do
      url "${BASE}/prbrowse-darwin-amd64.tar.gz"
      sha256 "${AMD_SHA}"
    end
  end

  on_linux do
    on_intel do
      url "${BASE}/prbrowse-linux-amd64.tar.gz"
      sha256 "${LINUX_SHA}"
    end
  end

  def install
    bin.install "prbrowse"
  end

  test do
    assert_match "prbrowse", shell_output("#{bin}/prbrowse --help")
  end
end
EOF
