#!/usr/bin/env python3
"""Attach a temporary viewer at one size and print the target's stable screen."""

import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

address = sys.argv[1]
columns = int(sys.argv[2])
rows = int(sys.argv[3])
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
viewer = subprocess.Popen(
    ["hc", "attach", address],
    stdin=slave,
    stdout=slave,
    stderr=slave,
    close_fds=True,
)
os.close(slave)


def drain():
    while True:
        ready, _, _ = select.select([master], [], [], 0)
        if not ready:
            return
        try:
            if not os.read(master, 65536):
                return
        except OSError:
            return


try:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        drain()
        result = subprocess.run(["hc", "get", "--json", address], capture_output=True, text=True)
        if result.returncode == 0 and json.loads(result.stdout).get("cols") == columns:
            break
        time.sleep(0.02)
    else:
        raise RuntimeError(f"terminal {address} did not resize to {columns} columns")

    previous = None
    stable = 0
    screen = ""
    while time.monotonic() < deadline:
        drain()
        result = subprocess.run(["hc", "read", "--lines", "200", address], capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or f"could not read {address}")
        screen = result.stdout
        if screen == previous:
            stable += 1
            if stable >= 2:
                break
        else:
            previous = screen
            stable = 0
        time.sleep(0.02)
    else:
        raise RuntimeError(f"terminal {address} did not settle after resize")

    sys.stdout.write(screen)
finally:
    viewer.send_signal(signal.SIGTERM)
    try:
        viewer.wait(timeout=2)
    except subprocess.TimeoutExpired:
        viewer.kill()
        viewer.wait()
    os.close(master)
