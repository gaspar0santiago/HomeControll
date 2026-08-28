"""One-off manual test for the 3.5-protocol plug. Not called by the server.

Usage:  python tools/plug_test2.py

Kept separate from plug_test.py because spotlight2 speaks Tuya protocol 3.5
while the other two speak 3.3, and that difference was the thing being
debugged. Credentials come from ../.env, not from this file.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import tinytuya
from plug_helper import load_device

dev = load_device('spotlight2')

d = tinytuya.OutletDevice(dev['id'], dev['ip'], dev['key'])
d.set_version(dev['ver'])
print(d.turn_on())
