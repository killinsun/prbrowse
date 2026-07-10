#!/usr/bin/env bash
# Generate a Homebrew formula snippet for the given version after a GitHub Release exists.
# Usage: ./scripts/update-formula.sh v0.1.0
set -euo pipefail

VERSION="${1:?version required, e.g. v0.1.0}"
VERSION="${VERSION#v}"
BASE="https://github.com/killinsun/prbrowse/releases/download/v${VERSION}"

sha() {
  local file="$1"
  curl -fsSL "${BASE}/${file}.sha256" | awk '{print $1}'
}

ARM_SHA="$(sha prbrowse-darwin-arm64.tar.gz)"
AMD_SHA="$(sha prbrowse-darwin-amd64.tar.gz)"
LINUX_SHA="$(sha prbrowse-linux-amd64.tar.gz)"

cat <<EOF
class Prbrowse < Formula
  desc "Browse GitHub PR review comments in a TUI"
  homepage "https://github.com/killinsun/prbrowse"
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
