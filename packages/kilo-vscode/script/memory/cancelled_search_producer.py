"""Actual queued ASGI read cancellation and retained terminal; no inference."""
import asyncio
import json
import sys
import threading
import uuid
from pathlib import Path
import httpx
from capture_recovery_test import Recovery

fixture = Recovery('test_committed_effect_and_original_request_are_verified_without_writes')
if len(sys.argv) == 4 and sys.argv[2] == '--source':
    fixture.source = Path(sys.argv[3])
fixture.setUp()
gate = threading.Event()
held = fixture.server.POOL.submit(gate.wait)


async def run():
    key = uuid.uuid4().hex
    headers = {'Authorization': 'Bearer '+fixture.key, 'X-Raya-Memory-Owner-Epoch': fixture.server.EPOCH,
               'X-Raya-Memory-Request-ID': key}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=fixture.server.app), base_url='http://127.0.0.1:8874') as client:
        task = asyncio.create_task(client.post('/v1/memory/search', json={'query': 'synthetic build preference'}, headers=headers))
        while key not in fixture.server.RECORDS or fixture.server.RECORDS[key]['future'] is None:
            await asyncio.sleep(.001)
        result = await client.delete('/v1/memory/requests/'+key, headers=headers)
        assert result.status_code == 200
        response = await task
        assert response.status_code == 499, response.text
        while fixture.server.RECORDS[key]['phase'] != 'terminal':
            await asyncio.sleep(.001)
        result = (await client.get('/v1/memory/requests/'+key, headers=headers)).json()
        assert result['operation_outcome'] == 'cancelled' and result['downstream'] == []
        return result


try:
    terminal = asyncio.run(asyncio.wait_for(run(), 10))
finally:
    gate.set()
    held.result()
fixture.server.POOL.shutdown(wait=True)
fixture.server.STORAGE.shutdown(wait=True)
print(json.dumps(dict(root=str(fixture.root), notes=str(fixture.notes), cfg=fixture.cfg,
    result={'operation': terminal}, operations=str(fixture.server.JOURNAL.folder))))
fixture._cleanups.clear()
