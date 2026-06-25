#!/bin/sh
# Lampa-Stream launcher.
# Sets up the electron runtime env (the bundled binary needs LD_LIBRARY_PATH
# pointing at its dist dir for its bundled .so files) and runs the app.
#
# TorrServer must be running for the «Торренты» source to work:
#   ~/torrserver/manage.sh start
#
# First run will ask for a TMDB Read Access Token (Streambert's setup flow).

cd "$(dirname "$0")"

export LD_LIBRARY_PATH="$PWD/node_modules/electron/dist${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export DISPLAY="${DISPLAY:-:1}"

# --no-sandbox is needed under some Wayland/compositor setups (Hyprland).
# --disable-gpu avoids nvidia-drm VAAPI warnings on Nvidia hosts (optional).
exec ./node_modules/electron/dist/electron . --no-sandbox "$@"
