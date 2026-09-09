#pragma once
#include <string>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <algorithm>
#define LOW 0
#define HIGH 1
#define OUTPUT 2
#define INPUT 1
using std::min;
struct String {
  std::string s;
  String() {}
  String(const char* c) : s(c) {}
  int indexOf(const char* n) const { auto p = s.find(n); return p == std::string::npos ? -1 : (int)p; }
  const char* c_str() const { return s.c_str(); }
};
struct _Serial {
  void begin(unsigned long) {}
  void println() {}
  void println(const char*) {}
  template <class T> void println(T) {}
  void print(const char*) {}
  template <class T> void print(T) {}
  template <class... A> void printf(const char*, A...) {}
} Serial;
inline void pinMode(int, int) {}
inline void digitalWrite(int, int) {}
inline void delay(unsigned long) {}
inline uint32_t millis() { return 0; }
