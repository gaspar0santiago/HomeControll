"""One-off manual BLE test for a Hello Fairy curtain. Not called by the server.

Usage:  python tools/fairy_test.py <MAC>
        python tools/fairy_test.py            # uses FAIRY1_MAC from ../.env

Sends the bare power-on frame, which is the quickest way to confirm the
curtain is in range and pairable before debugging anything else.
"""
import asyncio
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from bleak import BleakClient

load_dotenv(Path(__file__).resolve().parent.parent / '.env')

CMD_UUID = "49535343-8841-43f4-a8d4-ecbe34729bb3"
MAC = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('FAIRY1_MAC')

if not MAC:
    sys.exit('No MAC given. Pass one as an argument or set FAIRY1_MAC in .env')


async def main():
    print(f"Connecting to {MAC}...")
    async with BleakClient(MAC, timeout=10.0) as client:
        print("Connected! Turning on...")
        # NOTE: kept as originally written. fairy_helper.py terminates frames
        # with 0xBB, not 0xAE -- if this test does nothing, try 0xBB here.
        await client.write_gatt_char(CMD_UUID, bytes([0xAA, 0x02, 0x01, 0x01, 0xAE]), response=False)
        print("Done!")


asyncio.run(main())
