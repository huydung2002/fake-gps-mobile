#!/usr/bin/env python3
"""
Persistent GPS location worker for Windows — zero administrator privileges.
Supports:
  1. iOS 17+ in-process Userspace RSD Tunnel (PyTCP - no TAP/TUN driver, no root/admin)
  2. iOS <= 16 Lockdown DtSimulateLocation fallback (via usbmux)
  3. Legacy host:port connection
"""
import sys
import json
import asyncio
import threading
import inspect


def emit(obj):
    try:
        sys.stdout.write(json.dumps(obj) + '\n')
        sys.stdout.flush()
    except Exception:
        pass


async def do_set(loc, lat: float, lng: float):
    if inspect.iscoroutinefunction(loc.set):
        await loc.set(lat, lng)
    else:
        await asyncio.to_thread(loc.set, lat, lng)


async def do_clear(loc):
    if hasattr(loc, 'clear'):
        if inspect.iscoroutinefunction(loc.clear):
            await loc.clear()
        else:
            await asyncio.to_thread(loc.clear)


async def message_loop(loc, mode_name: str):
    emit({'status': 'ready', 'mode': mode_name})

    loop = asyncio.get_event_loop()
    cmd_queue: asyncio.Queue = asyncio.Queue()

    def stdin_reader():
        while True:
            try:
                line = sys.stdin.readline()
            except Exception:
                break
            if not line:
                loop.call_soon_threadsafe(cmd_queue.put_nowait, None)
                break
            stripped = line.strip()
            if stripped:
                loop.call_soon_threadsafe(cmd_queue.put_nowait, stripped)

    t = threading.Thread(target=stdin_reader, daemon=True)
    t.start()

    while True:
        try:
            cmd = await asyncio.wait_for(cmd_queue.get(), timeout=30.0)
        except asyncio.TimeoutError:
            continue

        if cmd is None or cmd == 'quit':
            try:
                await do_clear(loc)
            except Exception:
                pass
            break

        if cmd == 'ping':
            emit({'pong': True})
            continue

        if cmd == 'clear':
            try:
                await do_clear(loc)
                emit({'ok': True, 'action': 'clear'})
            except Exception as e:
                emit({'error': str(e)})
            continue

        if cmd == 'get-location':
            try:
                if hasattr(loc, 'get') and inspect.iscoroutinefunction(loc.get):
                    pos = await loc.get()
                    if pos and 'latitude' in pos:
                        emit({'ok': True, 'action': 'get-location', 'lat': pos['latitude'], 'lng': pos['longitude']})
                    else:
                        emit({'ok': False, 'action': 'get-location', 'error': 'No location data'})
                else:
                    emit({'ok': False, 'action': 'get-location', 'error': 'get-location not supported by engine'})
            except Exception as e:
                emit({'ok': False, 'action': 'get-location', 'error': str(e)})
            continue

        # Expected format: "lat,lng" or "set:lat,lng"
        if cmd.startswith('set:'):
            cmd = cmd[4:]

        try:
            lat_s, lng_s = cmd.split(',', 1)
            lat = float(lat_s.strip())
            lng = float(lng_s.strip())
            await do_set(loc, lat, lng)
            emit({'ok': True, 'lat': lat, 'lng': lng})
        except Exception as e:
            emit({'error': str(e)})


async def run_userspace_rsd(udid: str | None):
    from pymobiledevice3.remote.userspace_tunnel import establish_userspace_rsd
    from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
    from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation

    rsd = await establish_userspace_rsd(serial=udid)
    try:
        dvt = DvtProvider(rsd)
        await dvt.connect()
        try:
            loc = LocationSimulation(dvt)
            await loc.connect()
            try:
                await message_loop(loc, 'userspace-rsd')
            finally:
                try:
                    await loc.close()
                except Exception:
                    pass
        finally:
            try:
                await dvt.close()
            except Exception:
                pass
    finally:
        try:
            await rsd.close()
        except Exception:
            pass


async def run_lockdown(udid: str | None):
    from pymobiledevice3.lockdown import create_using_usbmux
    from pymobiledevice3.services.simulate_location import DtSimulateLocation

    lockdown = create_using_usbmux(serial=udid)
    loc = DtSimulateLocation(lockdown)
    try:
        await message_loop(loc, 'lockdown')
    finally:
        try:
            loc.close()
        except Exception:
            pass


async def run_host_port(host: str, port: int):
    from pymobiledevice3.remote.remote_service_discovery import RemoteServiceDiscoveryService
    from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
    from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation

    async with RemoteServiceDiscoveryService((host, port)) as rsd:
        async with DvtProvider(rsd) as dvt:
            async with LocationSimulation(dvt) as loc:
                await message_loop(loc, 'host-port')


async def main_async():
    target = sys.argv[1] if len(sys.argv) > 1 else None
    second = sys.argv[2] if len(sys.argv) > 2 else None

    # Check if host and port were provided: e.g. python location_worker.py 127.0.0.1 5555
    if target and second and second.isdigit():
        await run_host_port(target, int(second))
        return

    udid = None if (not target or target.lower() in ('auto', 'none', 'default')) else target

    # Try iOS 17+ Userspace RSD Tunnel first
    try:
        await run_userspace_rsd(udid)
        return
    except Exception as e_rsd:
        # Fallback to iOS <= 16 Lockdown simulation
        try:
            await run_lockdown(udid)
            return
        except Exception as e_lock:
            emit({'error': f'Failed connecting to device: RSD={e_rsd} | Lockdown={e_lock}'})
            sys.exit(1)


def main():
    try:
        asyncio.run(main_async())
    except KeyboardInterrupt:
        pass
    except Exception as e:
        emit({'error': str(e)})
        sys.exit(1)


if __name__ == '__main__':
    main()
