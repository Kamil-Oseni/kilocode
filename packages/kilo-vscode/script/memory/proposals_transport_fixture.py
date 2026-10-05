"""Disposable actual FastAPI/Store listener. EOF joins originals; no inference or apply."""
import json
import socket
import sys
import threading
import time
import uvicorn
from proposals_http_test import HTTP


fixture = HTTP('runTest')
sock = socket.socket()
server = None
child = None
try:
    sock.bind(('127.0.0.1', 8874))
    fixture.setUp()
    server = uvicorn.Server(uvicorn.Config(fixture.server.app, log_level='critical', access_log=False))
    child = threading.Thread(target=lambda: server.run(sockets=[sock]))
    child.start()
    until = time.monotonic() + 10
    while not server.started and child.is_alive() and time.monotonic() < until:
        time.sleep(.01)
    if not server.started:
        raise RuntimeError('Original disposable listener did not become ready.')
    # Consumed privately by the test; never send this credential to the Tool or SDK.
    print('RAYA_FIXTURE ' + json.dumps({'project': str(fixture.project), 'notes': str(fixture.notes),
                      'key': fixture.key, 'setup': {'format': 'raya.memory.setup', 'version': 2,
                      'protocol': 'raya.memory.operation.v1', 'origin': 'http://127.0.0.1:8874',
                      'root': str(fixture.notes), 'source_sha256': fixture.server.SOURCE}}), flush=True)
    for line in sys.stdin:
        if line.strip() != 'STOP':
            raise ValueError('Unknown fixture control.')
        break
finally:
    if server is not None:
        server.should_exit = True
    if child is not None and child.ident is not None:
        child.join()
    sock.close()
    fixture.doCleanups()
if not server.started or fixture.server.ACTIVE or fixture.server.REVIEWS or fixture.server.REVIEW_ERRORS:
    raise RuntimeError('Original fixture work remains unsettled.')
