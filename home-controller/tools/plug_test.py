"""One-off manual plug test used during setup. Not called by the server.

Usage:  python tools/plug_test.py [disco|spotlight|spotlight2]

Reads the plug's local id/ip/key from ../.env via plug_helper.load_device,
so no device keys live in this file.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import tinytuya
from plug_helper import load_device

name = sys.argv[1] if len(sys.argv) > 1 else 'disco'
dev = load_device(name)

d = tinytuya.OutletDevice(dev['id'], dev['ip'], dev['key'])
d.set_version(dev['ver'])
print(f'Turning on {name} ({dev["ip"]}, protocol {dev["ver"]})...')
print(d.turn_on())
