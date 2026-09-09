#pragma once
#include "Arduino.h"
struct WiFiClientSecure {
  void setCACert(const char*) {}
  void setInsecure() {}
};
