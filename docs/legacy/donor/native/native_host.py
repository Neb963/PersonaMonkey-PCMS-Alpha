#!/usr/bin/env python3
import json
import os
import socket
import struct
import sys

SOCKET_PATH = os.environ.get("PRM_SOCKET", "/run/persona-mullvad-router/control.sock")
MAX_IN = 1024 * 1024
MAX_OUT = 1024 * 1024


class OversizedNativeMessage(ValueError):
    """A frame whose declared body exceeds the supported input limit."""


def read_exact(stream, n):
    chunks = []
    remaining = n
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_message():
    header = read_exact(sys.stdin.buffer, 4)
    if header is None:
        return None
    (length,) = struct.unpack("<I", header)
    if length > MAX_IN:
        raise OversizedNativeMessage("native message too large")
    body = read_exact(sys.stdin.buffer, length)
    if body is None:
        return None
    obj = json.loads(body.decode("utf-8"))
    if not isinstance(obj, dict):
        raise ValueError("message must be an object")
    return obj


def write_message(obj):
    data = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    if len(data) > MAX_OUT:
        data = json.dumps({"ok": False, "error": "native response too large"}).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def call_daemon(req):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.settimeout(40)
        s.connect(SOCKET_PATH)
        s.sendall((json.dumps(req, separators=(",", ":")) + "\n").encode("utf-8"))
        buf = bytearray()
        while len(buf) < MAX_OUT:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf.extend(chunk)
            if b"\n" in chunk:
                break
        if not buf:
            raise RuntimeError("local Mullvad router returned no response")
        line = bytes(buf).split(b"\n", 1)[0]
        return json.loads(line.decode("utf-8"))
    finally:
        s.close()


def main():
    while True:
        req = None
        try:
            req = read_message()
            if req is None:
                return
            response = call_daemon(req)
        except OversizedNativeMessage:
            # The body is untrusted and may be huge. Exit without trying to
            # drain it: any following bytes could otherwise be mistaken for
            # another frame and desynchronize the native messaging stream.
            return
        except Exception as exc:
            response = {"ok": False, "error": str(exc)}
            if isinstance(req, dict) and "id" in req:
                response["id"] = req["id"]
        write_message(response)


if __name__ == "__main__":
    main()
