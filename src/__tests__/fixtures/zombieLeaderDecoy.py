# A process whose thread-group LEADER has exited while another thread still runs and holds a listening socket — the
# state a multi-threaded process (Node: the libuv pool) passes through on its way out: /proc/<pid>/stat reads `Z`,
# `Threads:` is still 2, and the port still accepts connections. Prints the port, then the main thread exits.
# Used by processIdentity.test.ts; run with `python3 -I`. Killed by the test (SIGKILL ends every thread).
import ctypes
import socket
import threading
import time

listener = socket.socket()
listener.bind(('127.0.0.1', 0))
listener.listen(8)
threading.Thread(target=lambda: time.sleep(60), daemon=False).start()
print(listener.getsockname()[1], flush=True)
ctypes.CDLL(None).pthread_exit(None)
