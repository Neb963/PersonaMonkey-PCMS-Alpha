import importlib.util
import io
import json
import struct
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("native_host", ROOT / "native" / "native_host.py")
native_host = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(native_host)


def frame(body):
    return struct.pack("<I", len(body)) + body


class NativeFramingTests(unittest.TestCase):
    def run_host(self, data):
        source = io.BytesIO(data)
        sink = io.BytesIO()
        stdin = SimpleNamespace(buffer=source)
        stdout = SimpleNamespace(buffer=sink)

        def daemon_response(request):
            return {"ok": True, "id": request.get("id")}

        with patch.object(native_host.sys, "stdin", stdin):
            with patch.object(native_host.sys, "stdout", stdout):
                with patch.object(native_host, "call_daemon", side_effect=daemon_response) as call_daemon:
                    native_host.main()

        return source.tell(), sink.getvalue(), call_daemon.call_args_list

    def decode_frames(self, data):
        decoded = []
        offset = 0
        while offset < len(data):
            self.assertGreaterEqual(len(data) - offset, 4, "response must have a complete length prefix")
            (length,) = struct.unpack_from("<I", data, offset)
            offset += 4
            self.assertLessEqual(offset + length, len(data), "response length must match available frame bytes")
            decoded.append(json.loads(data[offset : offset + length].decode("utf-8")))
            offset += length
        return decoded

    def test_maximum_and_just_below_limit_are_accepted(self):
        for body_length in (native_host.MAX_IN - 1, native_host.MAX_IN):
            with self.subTest(body_length=body_length):
                body = b'{"id":"boundary"}'
                body += b" " * (body_length - len(body))
                consumed, output, calls = self.run_host(frame(body))

                self.assertEqual(consumed, body_length + 4)
                self.assertEqual(self.decode_frames(output), [{"ok": True, "id": "boundary"}])
                self.assertEqual(len(calls), 1)

    def test_one_byte_over_limit_terminates_before_body_or_following_frame(self):
        oversized_length = native_host.MAX_IN + 1
        oversized_body = b"{}" + b" " * (oversized_length - 2)
        sentinel = frame(b'{"id":"sentinel"}')

        consumed, output, calls = self.run_host(frame(oversized_body) + sentinel)

        # Oversize policy: stop immediately after the header and emit no response;
        # the native messaging process exits, so no later frame is interpreted.
        self.assertEqual(consumed, 4)
        self.assertEqual(output, b"")
        self.assertEqual(calls, [])

    def test_uint32_max_length_terminates_immediately(self):
        sentinel = frame(b'{"id":"sentinel"}')

        consumed, output, calls = self.run_host(struct.pack("<I", 0xFFFFFFFF) + sentinel)

        self.assertEqual(consumed, 4)
        self.assertEqual(output, b"")
        self.assertEqual(calls, [])

    def test_empty_and_malformed_complete_frames_do_not_desynchronize(self):
        sentinel = frame(b'{"id":"sentinel"}')
        for malformed_body in (b"", b"{not-json"):
            with self.subTest(malformed_body=malformed_body):
                consumed, output, calls = self.run_host(frame(malformed_body) + sentinel)
                responses = self.decode_frames(output)

                self.assertEqual(consumed, len(frame(malformed_body)) + len(sentinel))
                self.assertEqual(len(responses), 2)
                self.assertFalse(responses[0]["ok"])
                self.assertEqual(responses[1], {"ok": True, "id": "sentinel"})
                self.assertEqual([call.args[0]["id"] for call in calls], ["sentinel"])

    def test_truncated_header_or_body_exits_without_response(self):
        truncated_inputs = (
            b"\x01",
            b"\x01\x00",
            b"\x01\x00\x00",
            struct.pack("<I", 5) + b"{}",
        )
        for data in truncated_inputs:
            with self.subTest(data=data):
                consumed, output, calls = self.run_host(data)
                self.assertEqual(consumed, len(data))
                self.assertEqual(output, b"")
                self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
