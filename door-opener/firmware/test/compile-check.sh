#!/usr/bin/env bash
# Syntax and type check door_opener.ino against stubbed Arduino headers,
# in both DOOR_BENCH_TEST states, since each compiles different code.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SKETCH="$HERE/../door_opener/door_opener.ino"
CONFIG="$HERE/../door_opener/config.h.example"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cp "$HERE"/stubs/*.h "$WORK/"

for bench in 0 1; do
  sed "s/#define DOOR_BENCH_TEST 0/#define DOOR_BENCH_TEST $bench/" "$CONFIG" > "$WORK/config.h"
  cp "$SKETCH" "$WORK/sketch.cpp"
  echo 'int main(){ setup(); loop(); return 0; }' >> "$WORK/sketch.cpp"
  # -Werror because a warning here is a warning the Arduino IDE will show
  # too, and nobody reads those.
  ( cd "$WORK" && g++ -std=c++17 -I. -Wall -Wextra -Wno-unused-parameter -Werror -fsyntax-only sketch.cpp )
  echo "DOOR_BENCH_TEST=$bench compiles clean"
done
