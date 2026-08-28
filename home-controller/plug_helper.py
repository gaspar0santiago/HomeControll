import os
import sys
import json
import logging
from pathlib import Path

logging.disable(logging.CRITICAL)

from dotenv import load_dotenv
import tinytuya

# Load the .env sitting next to this script, so the helper works whatever cwd
# the server happens to spawn it with.
load_dotenv(Path(__file__).with_name('.env'))

# Logical plug name -> PLUG_<NAME>_* env var prefix.
# Add a plug by adding a name here and the matching vars to .env.
PLUG_NAMES = ('disco', 'spotlight', 'spotlight2')


def load_device(name):
    """Read one plug's local credentials out of the environment."""
    if name not in PLUG_NAMES:
        raise KeyError(f"Unknown plug '{name}'")
    prefix = 'PLUG_' + name.upper()
    dev = {
        'id':  os.environ.get(f'{prefix}_ID'),
        'ip':  os.environ.get(f'{prefix}_IP'),
        'key': os.environ.get(f'{prefix}_KEY'),
        'ver': os.environ.get(f'{prefix}_VER', '3.3'),
    }
    missing = [f'{prefix}_{k.upper()}' for k in ('id', 'ip', 'key') if not dev[k]]
    if missing:
        raise RuntimeError('Missing env vars: ' + ', '.join(missing))
    dev['ver'] = float(dev['ver'])
    return dev


def main():
    params = json.loads(sys.argv[1])
    name = params.get('device', 'disco')
    try:
        dev = load_device(name)
        d = tinytuya.OutletDevice(dev['id'], dev['ip'], dev['key'])
        d.set_version(dev['ver'])
        if params.get('on') is True:
            result = d.turn_on()
        elif params.get('on') is False:
            result = d.turn_off()
        else:
            result = d.status()
        print(json.dumps({"ok": True, "result": str(result)}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


# Guarded so tools/ can `from plug_helper import load_device` without
# running a command. server.js invokes this as a script, so it still runs.
if __name__ == '__main__':
    main()
