# Development shell for EventKit.
#
#   nix-shell                      # then: pnpm install && pnpm bootstrap && pnpm dev:simulate
#   nix-shell --arg pkgs 'import (fetchTarball "channel:nixos-unstable") {}'   # pick nixpkgs
#
# Linux (including NixOS): an FHS environment, so the binaries pnpm downloads (Electron,
# Prisma engines, esbuild, the @node-rs/argon2 addon, electron-builder's tools) run unpatched.
# macOS: a plain shell; those binaries run natively there.
{ pkgs ? import <nixpkgs> { } }:

let
  inherit (pkgs) lib stdenv;

  # pnpm 10 reads `packageManager` in package.json and switches to that exact version itself.
  pnpm = pkgs.pnpm_10 or pkgs.pnpm;

  tools = [
    pkgs.nodejs_22 # engines: >=22.12
    pnpm
    pkgs.git
    pkgs.openssl # Prisma probes `openssl version` and loads libssl
    pkgs.sqlite # inspect the dev database, deploy/backup.sh
    pkgs.cacert
  ];

  # X11 libraries moved from `xorg.*` to top-level names in newer nixpkgs.
  x11 = name: oldName: pkgs.${name} or pkgs.xorg.${oldName};

  # Runtime libraries for the Electron (Chromium) binary from npm, plus what the setup
  # engine and electron-builder shell out to on Linux.
  linuxLibs = with pkgs; [
    stdenv.cc.cc.lib
    zlib
    glib
    nss
    nspr
    dbus
    atk
    at-spi2-atk
    at-spi2-core
    cups
    expat
    libdrm
    (pkgs.libgbm or mesa)
    libGL
    vulkan-loader
    libxkbcommon
    cairo
    pango
    gtk3
    gdk-pixbuf
    alsa-lib
    systemd # libudev
    libnotify
    fontconfig
    freetype
    libsecret # safeStorage (OS keychain) on Linux
    libuuid
    (x11 "libx11" "libX11")
    (x11 "libxcomposite" "libXcomposite")
    (x11 "libxdamage" "libXdamage")
    (x11 "libxext" "libXext")
    (x11 "libxfixes" "libXfixes")
    (x11 "libxrandr" "libXrandr")
    (x11 "libxcb" "libxcb")
    (x11 "libxshmfence" "libxshmfence")
    (x11 "libxscrnsaver" "libXScrnSaver")
    (x11 "libxtst" "libXtst")
    xdg-utils
    # setup engine (tar/unzip extraction) and electron-builder (bundled Ruby for fpm)
    gnutar
    xz
    unzip
    zip
    libxcrypt-legacy
  ];

  banner = ''
    echo "EventKit dev shell: node $(node --version), $(command -v pnpm >/dev/null && echo "pnpm $(pnpm --version)")"
    echo "  first time:  pnpm install && pnpm bootstrap"
    echo "  run:         pnpm dev:simulate"
  '';
in
if stdenv.isLinux then
  let
    fhs = pkgs.buildFHSEnv {
      name = "eventkit-dev";
      targetPkgs = _: tools ++ linuxLibs;
      profile = ''
        export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
        export NIX_SSL_CERT_FILE=$SSL_CERT_FILE
        # Chromium needs at least one font; minimal hosts (containers, CI) have none.
        if [ ! -e /etc/fonts/fonts.conf ]; then
          export FONTCONFIG_FILE=${pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; }}
        fi
        if [[ $- == *i* ]]; then
          ${banner}
        fi
      '';
      runScript = "bash";
    };
  in
  # `nix-shell` enters the environment; `nix-build shell.nix -A fhs` builds a launcher
  # (./result/bin/eventkit-dev [-c 'command']) for scripts and CI.
  fhs.env // { inherit fhs; }
else
  pkgs.mkShell {
    packages = tools;
    shellHook = banner;
  }
