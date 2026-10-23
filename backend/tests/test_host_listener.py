import socket

import pytest

from amazme_backend.host import loopback_listener


def test_host_reclaims_persisted_port_after_connection_closed():
    with loopback_listener(0) as listener:
        address = listener.getsockname()
        with socket.create_connection(address, timeout=2) as client:
            accepted, _ = listener.accept()
            accepted.close()
            assert client.recv(1) == b""
    # Server actively closed: its accepted connection remains in TCP TIME_WAIT.
    with loopback_listener(address[1]) as restarted:
        assert restarted.getsockname() == address
        with socket.create_connection(address, timeout=2):
            accepted, _ = restarted.accept()
            accepted.close()


def test_host_never_shares_a_live_listening_port():
    with loopback_listener(0) as first:
        with pytest.raises(OSError):
            with loopback_listener(first.getsockname()[1]):
                pytest.fail("Two Hosts must not listen on the same port")
