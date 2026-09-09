#pragma once
#include "Arduino.h"
#include "WiFiClientSecure.h"
#include "WiFiClient.h"
struct HTTPClient {
  bool begin(WiFiClientSecure&, const char*) { return true; }
  bool begin(WiFiClient&, const char*) { return true; }
  void setTimeout(int) {}
  void setConnectTimeout(int) {}
  void setReuse(bool) {}
  void addHeader(const char*, const char*) {}
  int POST(const char*) { return 200; }
  String getString() { return String("{\"open\":false}"); }
  void end() {}
  String errorToString(int) { return String("err"); }
};
