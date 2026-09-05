#!/bin/sh
set -e

# MusePi TUI Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/MuseLinn/MusePi/main/scripts/install.sh | sh
#
# Default installs the prebuilt TUI binary published by the release CICD
# (musepi-<os>-<arch> + SHA256SUMS.txt on the GitHub release). Use --source
# to clone and build from source instead.
#
# Options:
#   --binary       Install the prebuilt release binary (default)
#   --source       Install from source (clone + build)
#   --ref <ref>    Install specific tag/commit/branch
#   -r <ref>       Shorthand for --ref

REPO="MuseLinn/MusePi"
MIN_BUN_VERSION="1.3.14"

# Parse arguments
MODE=""
REF=""
while [ $# -gt 0 ]; do
    case "$1" in
        --source)
            MODE="source"
            shift
            ;;
        --binary)
            MODE="binary"
            shift
            ;;
        --ref)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        --ref=*)
            REF="${1#*=}"
            if [ -z "$REF" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            shift
            ;;
        -r)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for -r"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Default to binary install; a --ref without a mode still means binary.
if [ -z "$MODE" ]; then
    MODE="binary"
fi

# Normalized host architecture (x64|arm64). On macOS this uses
# `sysctl hw.optional.arm64` so it stays correct inside a Rosetta session,
# where `uname -m` reports the translated x86_64.
host_arch() {
    if [ "$(uname -s)" = "Darwin" ]; then
        if [ "$(sysctl -in hw.optional.arm64 2>/dev/null || /usr/sbin/sysctl -in hw.optional.arm64 2>/dev/null)" = "1" ]; then
            echo "arm64"
        else
            echo "x64"
        fi
        return
    fi
    case "$(uname -m)" in
        x86_64|amd64)  echo "x64" ;;
        arm64|aarch64) echo "arm64" ;;
        *)             uname -m ;;
    esac
}

# The release asset name for this host, or empty when no prebuilt binary
# exists (e.g. unsupported arch or non-Linux/macOS OS).
release_asset() {
    os="$(uname -s)"
    arch="$(host_arch)"
    case "$os" in
        Linux)
            # The release publishes glibc and musl variants for Linux; pick
            # musl when ldd reports musl (Alpine and other musl distros).
            if ldd --version 2>/dev/null | grep -qi musl; then
                echo "musepi-linux-musl-$arch"
            else
                echo "musepi-linux-$arch"
            fi
            ;;
        Darwin)
            echo "musepi-darwin-$arch"
            ;;
        *)
            echo ""
            ;;
    esac
}

# Check if git is available
has_git() {
    command -v git >/dev/null 2>&1
}

has_curl() {
    command -v curl >/dev/null 2>&1
}

# Install the prebuilt release binary. No bun or git required.
install_binary() {
    asset="$(release_asset)"
    if [ -z "$asset" ]; then
        echo "No prebuilt musepi binary for host '$(uname -s)'/$(host_arch)."
        echo "Install from source instead: sh install.sh --source"
        exit 1
    fi

    if ! has_curl; then
        echo "curl is required to download the release binary"
        exit 1
    fi

    BIN_DIR="${PI_BIN_DIR:-$HOME/.musepi/bin}"
    if [ -n "$REF" ]; then
        base_url="https://github.com/${REPO}/releases/download/${REF}"
    else
        # GitHub's /releases/latest/download/<asset> redirects to the newest
        # release's asset, so no tag lookup is needed.
        base_url="https://github.com/${REPO}/releases/latest/download"
    fi

    tmp_dir="$(mktemp -d)"
    trap 'rm -rf "$tmp_dir"' EXIT
    echo "Downloading $asset ..."
    curl -fL --progress-bar --retry 3 -o "$tmp_dir/$asset" "$base_url/$asset"

    # Verify against the release's SHA256SUMS.txt ("<sha256>  <basename>").
    echo "Verifying checksum ..."
    curl -fsSL --retry 3 -o "$tmp_dir/SHA256SUMS.txt" "$base_url/SHA256SUMS.txt"
    expected="$(awk -v name="$asset" '$2 == name { print $1 }' "$tmp_dir/SHA256SUMS.txt")"
    if [ -z "$expected" ]; then
        echo "SHA256SUMS.txt has no entry for $asset" >&2
        exit 1
    fi
    if command -v sha256sum >/dev/null 2>&1; then
        actual="$(sha256sum "$tmp_dir/$asset" | awk '{ print $1 }')"
    else
        actual="$(shasum -a 256 "$tmp_dir/$asset" | awk '{ print $1 }')"
    fi
    if [ "$expected" != "$actual" ]; then
        echo "Checksum mismatch for $asset (expected $expected, got $actual)" >&2
        exit 1
    fi

    mkdir -p "$BIN_DIR"
    install -m 755 "$tmp_dir/$asset" "$BIN_DIR/musepi"
    trap - EXIT
    rm -rf "$tmp_dir"

    version="$("$BIN_DIR/musepi" --version)"
    echo ""
    echo "✓ Installed musepi $version (TUI binary) to $BIN_DIR/musepi"
    echo "Run: $BIN_DIR/musepi"
}

# Install from source: clone the repo and run the workspace setup.
install_from_source() {
    echo "Installing from source..."
    if ! has_git; then
        echo "git is required to install from source"
        exit 1
    fi
    if ! has_bun; then
        install_bun
    fi

    CLONE_DIR="${PI_CLONE_DIR:-$HOME/.musepi/repo}"

    if [ -d "$CLONE_DIR/.git" ]; then
        echo "Using existing checkout at $CLONE_DIR"
        if [ -n "$REF" ]; then
            (cd "$CLONE_DIR" && git fetch --depth 1 origin "$REF" && git checkout -f "$REF") || \
                (cd "$CLONE_DIR" && git checkout "$REF") || \
                { echo "Failed to checkout $REF"; exit 1; }
        else
            (cd "$CLONE_DIR" && git pull --ff-only) || \
                { echo "Failed to update checkout"; exit 1; }
        fi
    else
        if [ -n "$REF" ]; then
            git clone --depth 1 --branch "$REF" "https://github.com/${REPO}.git" "$CLONE_DIR" 2>/dev/null || \
                git clone "https://github.com/${REPO}.git" "$CLONE_DIR"
        else
            git clone --depth 1 "https://github.com/${REPO}.git" "$CLONE_DIR"
        fi
    fi

    if [ ! -d "$CLONE_DIR/packages/coding-agent" ]; then
        echo "Expected package at ${CLONE_DIR}/packages/coding-agent"
        exit 1
    fi

    echo "Running setup (workspace install + natives + link)..."
    (cd "$CLONE_DIR" && bun run setup) || {
        echo "Failed to run 'bun run setup'"
        exit 1
    }

    echo ""
    echo "✓ Installed musepi from source"
    echo "Run: cd $CLONE_DIR && bun run musepi"
}

# Check if bun is available
has_bun() {
    command -v bun >/dev/null 2>&1
}

# Bun's own architecture (x64|arm64), or empty when it can't be determined.
bun_arch() {
    bun -e 'process.stdout.write(process.arch)' 2>/dev/null
}

# True when Bun's architecture matches the host. If Bun's arch can't be read,
# assume a match rather than block the install.
bun_arch_matches_host() {
    ba="$(bun_arch)"
    [ -z "$ba" ] && return 0
    [ "$ba" = "$(host_arch)" ]
}

version_ge() {
    current="$1"
    minimum="$2"

    current_major="${current%%.*}"
    current_rest="${current#*.}"
    current_minor="${current_rest%%.*}"
    current_patch="${current_rest#*.}"
    current_patch="${current_patch%%.*}"

    minimum_major="${minimum%%.*}"
    minimum_rest="${minimum#*.}"
    minimum_minor="${minimum_rest%%.*}"
    minimum_patch="${minimum_rest#*.}"
    minimum_patch="${minimum_patch%%.*}"

    if [ "$current_major" -ne "$minimum_major" ]; then
        [ "$current_major" -gt "$minimum_major" ]
        return $?
    fi

    if [ "$current_minor" -ne "$minimum_minor" ]; then
        [ "$current_minor" -gt "$minimum_minor" ]
        return $?
    fi

    [ "$current_patch" -ge "$minimum_patch" ]
}

require_bun_version() {
    version_raw=$(bun --version 2>/dev/null || true)
    if [ -z "$version_raw" ]; then
        echo "Failed to read bun version"
        exit 1
    fi

    version_clean=${version_raw%%-*}
    if ! version_ge "$version_clean" "$MIN_BUN_VERSION"; then
        echo "Bun ${MIN_BUN_VERSION} or newer is required. Current version: ${version_clean}"
        echo "Upgrade Bun at https://bun.sh/docs/installation"
        exit 1
    fi
}

# Install bun
install_bun() {
    echo "Installing bun..."
    if command -v bash >/dev/null 2>&1; then
        curl -fsSL https://bun.sh/install | bash
    else
        echo "bash not found; attempting install with sh..."
        curl -fsSL https://bun.sh/install | sh
    fi
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    require_bun_version
}

# Main logic
case "$MODE" in
    source)
        if ! has_bun; then
            install_bun
        fi
        require_bun_version
        if ! bun_arch_matches_host; then
            echo "Error: bun reports architecture '$(bun_arch)' but this host is '$(host_arch)'."
            echo "Installing from source with this bun would produce a mismatched binary"
            echo "(e.g. x86_64 under Rosetta on Apple Silicon), causing slow startup and AVX warnings."
            echo "Install a native bun for your architecture, then re-run."
            exit 1
        fi
        install_from_source
        ;;
    binary)
        install_binary
        ;;
    *)
        echo "Unknown mode: $MODE"
        exit 1
        ;;
esac
