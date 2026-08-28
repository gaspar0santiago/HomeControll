import sys
import json
import asyncio
from bleak import BleakClient

CMD_UUID = "49535343-8841-43f4-a8d4-ecbe34729bb3"

def h2b(hex_str):
    return bytes.fromhex(hex_str.replace(' ', ''))

def power_cmd(on):
    return h2b('AA020101BB' if on else 'AA020100BB')

def color_cmd(hue, sat, bri):
    h = min(360, max(0, round(hue)))
    s = min(1000, max(0, round(sat * 10)))
    v = min(1000, max(0, round(bri * 10)))
    return h2b(f'AA030701{h:04X}{s:04X}{v:04X}BB')

def white_cmd(bri):
    v = min(1000, max(0, round(bri * 10)))
    return h2b(f'AA03070100000000{v:04X}BB')

def music_cmd(mode_id, sensitivity, hue):
    # Confirmed format: AA 03 09 03 [modeId] [sens] 03E8 [hue 2B] 03E8 BB
    # Vol and brightness always 03E8 (1000/max) -- matches confirmed working command
    sens = min(100, max(1, round(sensitivity)))
    h    = min(360, max(0, round(hue)))
    return h2b(f'AA030903{mode_id:02X}{sens:02X}03E8{h:04X}03E8BB')

MUSIC_MODES = {
    'energy':   0x11,
    'rhythm':   0x21,
    'rolling':  0x31,
    'spectrum': 0x41,
    'rainbow':  0x51
}

async def main():
    params = json.loads(sys.argv[1])
    mac    = params['mac']

    try:
        async with BleakClient(mac, timeout=10.0) as client:
            music = params.get('music')

            if params.get('on') is False:
                await client.write_gatt_char(CMD_UUID, power_cmd(False), response=False)

            elif music and music in MUSIC_MODES:
                sens = params.get('sensitivity', 80)
                hue  = params.get('hue', 160)
                cmd  = music_cmd(MUSIC_MODES[music], sens, hue)
                await client.write_gatt_char(CMD_UUID, power_cmd(True), response=False)
                await asyncio.sleep(0.2)
                await client.write_gatt_char(CMD_UUID, cmd, response=False)

            elif params.get('white'):
                bri = params.get('brightness', 80)
                await client.write_gatt_char(CMD_UUID, power_cmd(True), response=False)
                await asyncio.sleep(0.2)
                await client.write_gatt_char(CMD_UUID, white_cmd(bri), response=False)

            elif 'hue' in params:
                cmd = color_cmd(
                    params['hue'],
                    params.get('saturation', 100),
                    params.get('brightness', 80)
                )
                await client.write_gatt_char(CMD_UUID, power_cmd(True), response=False)
                await asyncio.sleep(0.2)
                await client.write_gatt_char(CMD_UUID, cmd, response=False)

            else:
                await client.write_gatt_char(CMD_UUID, power_cmd(True), response=False)

        print(json.dumps({"ok": True}))

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

asyncio.run(main())
