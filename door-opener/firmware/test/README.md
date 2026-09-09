# Firmware compile check

There is no Arduino toolchain in CI, so `stubs/` holds just enough of the
ESP32 Arduino API for `g++ -fsyntax-only` to parse `door_opener.ino`. It
catches the failure that costs the most time in practice: a sketch that
does not compile, discovered while standing at the door with a laptop.

It proves the sketch parses and type checks against the API it claims to
use. It does not prove anything about the hardware, so the bench test in
`DOOR_BENCH_TEST` is still the thing that tells you the relay works.

```
cd door-opener/firmware/test && ./compile-check.sh
```
