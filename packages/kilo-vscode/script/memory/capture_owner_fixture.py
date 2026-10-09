"""Original localhost capture producer with real journals; synthetic notes only."""
import json
import os
import socket
import sys
import threading
import uvicorn
from capture_http_test import HTTP


def main():
    fixture = HTTP('test_capture_auth_original_epoch_publication_and_no_replay')
    fixture.setUp()
    server = None
    unavailable = socket.socket()
    unavailable.bind(('127.0.0.1', 0))
    os.environ['RAYA_RETRIEVAL_PORT'] = str(unavailable.getsockname()[1])
    try:
        if sys.argv[1:] == ['--indexed-empty']:
            fixture.server.INDEX.sync(expected=fixture.sha)
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        listener.listen()
        fixture.server.PORT = listener.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(fixture.server.app, log_level='error', lifespan='off'))
        def close():
            if sys.stdin.buffer.read() != b'':
                raise ValueError('Fixture shutdown accepts EOF only.')
            server.should_exit = True
        reader = threading.Thread(target=close)
        reader.start()
        print(json.dumps(dict(root=str(fixture.notes), temporary=str(fixture.root), key=fixture.key,
            origin='http://127.0.0.1:' + str(listener.getsockname()[1]), body=fixture.body,
            policy_sha256=fixture.sha, source_sha256=fixture.server.SOURCE)), flush=True)
        server.run(sockets=[listener])
        reader.join()
        if sys.argv[1:] == ['--indexed-empty']:
            assert not any(name in sys.modules for name in ('torch', 'transformers', 'scipy', 'sklearn'))
    finally:
        fixture.doCleanups()
        unavailable.close()


if __name__ == '__main__':
    main()
