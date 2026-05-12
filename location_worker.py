#!/usr/bin/env python3
"""
Persistent GPS location worker for Windows — latest pymobiledevice3.
Uses a background thread for blocking stdin reads instead of
connect_read_pipe (which crashes on Windows Python 3.12+ with
Electron-piped stdin due to IOCP handle issues).
"""
import sys
import json
import asyncio
import threading


def emit(obj):
    sys.stdout.write(json.dumps(obj) + '\n')
    sys.stdout.flush()


async def run(host: str, port: int):
    try:
        from pymobiledevice3.remote.remote_service_discovery import RemoteServiceDiscoveryService
        from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
        from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation
    except ImportError as e:
        emit({'error': f'Import error: {e}'})
        return

    try:
        async with RemoteServiceDiscoveryService((host, port)) as rsd:
            async with DvtProvider(rsd) as dvt:
                async with LocationSimulation(dvt) as loc:
                    emit({'status': 'ready'})

                    loop = asyncio.get_event_loop()
                    # Queue for passing commands from the stdin thread to the async loop
                    cmd_queue: asyncio.Queue = asyncio.Queue()

                    def stdin_reader():
                        """Blocking stdin reader running in a background thread."""
                        while True:
                            try:
                                line = sys.stdin.readline()
                            except Exception:
                                break
                            if not line:
                                # EOF — parent process closed stdin
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

                        if cmd is None:
                            break

                        if cmd == 'quit':
                            try:
                                await loc.clear()
                            except Exception:
                                pass
                            break

                        if cmd == 'clear':
                            try:
                                await loc.clear()
                                emit({'ok': True, 'action': 'clear'})
                            except Exception as e:
                                emit({'error': str(e)})
                            continue

                        if cmd == 'get-location':
                            try:
                                pos = await loc.get()
                                if pos and 'latitude' in pos:
                                    emit({'ok': True, 'action': 'get-location',
                                          'lat': pos['latitude'], 'lng': pos['longitude']})
                                else:
                                    emit({'ok': False, 'action': 'get-location', 'error': 'No location data'})
                            except Exception as e:
                                emit({'ok': False, 'action': 'get-location', 'error': str(e)})
                            continue

                        # Expected format: "lat,lng"
                        try:
                            lat_s, lng_s = cmd.split(',', 1)
                            await loc.set(float(lat_s), float(lng_s))
                            emit({'ok': True})
                        except Exception as e:
                            emit({'error': str(e)})

    except Exception as e:
        emit({'error': str(e)})


def main():
    if len(sys.argv) < 3:
        emit({'error': 'Usage: location_worker.py <host> <port>'})
        sys.exit(1)

    host = sys.argv[1]
    port = int(sys.argv[2])

    try:
        asyncio.run(run(host, port))
    except KeyboardInterrupt:
        pass
    except Exception as e:
        emit({'error': str(e)})
        sys.exit(1)


if __name__ == '__main__':
    main()
