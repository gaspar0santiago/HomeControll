#pragma once
#include "Arduino.h"
#define WL_CONNECTED 3
#define WIFI_STA 1
struct _IP { };
inline _Serial& operator<<(_Serial& s, _IP) { return s; }
struct _WiFi {
  int status() { return WL_CONNECTED; }
  void mode(int) {}
  void setSleep(bool) {}
  void setAutoReconnect(bool) {}
  void begin(const char*, const char*) {}
  _IP localIP() { return _IP(); }
} WiFi;
inline void _print_ip(_IP) {}
