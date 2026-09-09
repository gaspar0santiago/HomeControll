import sys
import json
import asyncio
from tapo import ApiClient

async def connect(client, ip, is_color, is_effect):
    if is_color or is_effect:
        order = ['l920', 'l930', 'l900', 'l530', 'l630']
    else:
        order = ['l530', 'l630', 'l510', 'l610', 'l900', 'l920', 'l930']
    for dtype in order:
        try:
            device = await getattr(client, dtype)(ip)
            print(f"Connected as {dtype}", file=sys.stderr)
            return device
        except Exception:
            continue
    return None

async def main():
    data = json.loads(sys.argv[1])
    email = data['email']
    password = data['password']
    ip = data['ip']
    is_color = 'hue' in data and 'saturation' in data
    is_effect = 'effect' in data
    # 'set' (the default) is every existing caller. 'read' is the door
    # opener's flash, which has to know what the bulb was doing before it
    # borrows it.
    action = data.get('action', 'set')

    for attempt in range(3):
        try:
            client = ApiClient(email, password)
            device = await connect(client, ip, is_color, is_effect)

            if device is None:
                print(json.dumps({"error": "Could not connect"}))
                sys.exit(1)

            # Returns before the device.on() below, and it has to. Every
            # command in this helper switches the bulb on first, so a read
            # that fell through would turn the light on just by asking it
            # what state it was in.
            if action == 'read':
                info = await device.get_device_info()
                print(json.dumps({"ok": True, "state": {
                    "device_on":  getattr(info, 'device_on', None),
                    "brightness": getattr(info, 'brightness', None),
                    "hue":        getattr(info, 'hue', None),
                    "saturation": getattr(info, 'saturation', None),
                    "color_temp": getattr(info, 'color_temp', None),
                }}))
                return

            await device.on()
            await asyncio.sleep(0.3)

            if is_effect:
                from tapo.requests import LightingEffectPreset
                effect_map = {
                    'rainbow':   LightingEffectPreset.Rainbow,
                    'aurora':    LightingEffectPreset.Aurora,
                    'ocean':     LightingEffectPreset.Ocean,
                    'lightning': LightingEffectPreset.Lightning,
                    'spring':    LightingEffectPreset.Spring,
                    'sunset':    LightingEffectPreset.Sunset,
                    'sunrise':   LightingEffectPreset.Sunrise,
                    'flicker':   LightingEffectPreset.Flicker,
                    'icicle':    LightingEffectPreset.Icicle,
                }
                preset = effect_map.get(data['effect'], LightingEffectPreset.Rainbow)
                await device.set_lighting_effect(preset)

            elif is_color:
                await device.set_hue_saturation(int(data['hue']), int(data['saturation']))
                await asyncio.sleep(0.1)
                if 'brightness' in data:
                    await device.set_brightness(int(data['brightness']))

            elif 'color_temp' in data:
                await device.set_color_temperature(int(data['color_temp']))
                if 'brightness' in data:
                    await device.set_brightness(int(data['brightness']))

            elif 'brightness' in data:
                await device.set_brightness(int(data['brightness']))

            if 'on' in data and data['on'] is False:
                await device.off()

            print(json.dumps({"ok": True}))
            return

        except Exception as e:
            if 'SESSION_TIMEOUT' in str(e) and attempt < 2:
                print(f"Session timeout, retrying ({attempt + 1})...", file=sys.stderr)
                await asyncio.sleep(1)
                continue
            print(json.dumps({"error": str(e)}))
            sys.exit(1)

asyncio.run(main())
