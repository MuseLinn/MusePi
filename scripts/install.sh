#!/bin/sh
set -e

# OMP Coding Agent Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/MuseLinn/MusePi/main/scripts/install.sh | sh
#
# Options:
#   --source       Install from source (default)
#   --binary       Not yet available (prebuilt binaries aren't attached to releases)
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

# If a ref is provided, default to source install
if [ -n "$REF" ] && [ -z "$MODE" ]; then
    MODE="source"
fi

# Check if bun is available
has_bun() {
    command -v bun >/dev/null 2>&1
}

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

# Check if git is available
has_git() {
    command -v git >/dev/null 2>&1
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

# Check if git-lfs is available
has_git_lfs() {
    command -v git-lfs >/dev/null 2>&1
}

# Install from source: clone the repo and run the workspace setup. This is the
# only supported install path — the npm package (@musepi/pi-coding-agent) is
# never published, and prebuilt TUI binaries are not attached to releases.
install_from_source() {
    echo "Installing from source..."
    if ! has_git; then
        echo "git is required to install from source"
        exit 1
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
        echo "Error: prebuilt TUI binaries are not yet attached to releases."
        echo "Install from source instead (the default — no flag needed)."
        exit 1
        ;;
    *)
        # Default: install from source. bun arch must match the host (a
        # mismatched bun would build wrong-arch natives), so provision a
        # matching bun when needed.
        if has_bun && bun_arch_matches_host; then
            require_bun_version
        else
            if has_bun; then
                echo "Detected bun with architecture '$(bun_arch)' on a '$(host_arch)' host; installing a matching bun instead."
            fi
            install_bun
        fi
        install_from_source
        ;;
esac
