"""Read-only committed-capture review. No locks, writers, services or models."""
import hashlib
import json
from pathlib import Path
import sys


def review(cfg):
    source = Path(cfg['source']).resolve(strict=True)
    root = Path(cfg['root']).resolve(strict=True)
    pins = cfg['pins']
    names = {'server.py', 'index.py', 'notes.py', 'policy.py', 'admission.py', 'host.py',
             'operations.py', 'retirement.py', 'namespace.py', 'historical.py', 'dispatch.py', 'proposals.py', 'capture.py'}
    assert isinstance(pins, dict) and set(pins) == names
    for name, expected in pins.items():
        file = source / name
        assert not file.is_symlink() and not file.is_junction() and file.stat().st_nlink == 1
        assert hashlib.sha256(file.read_bytes()).hexdigest() == expected
    sys.path.insert(0, str(source))
    from admission import image, serialize
    from capture import committed, validate
    from notes import Store, safe, digest
    from policy import Policy
    from retirement import fingerprint

    # Bypass only Store's directory-creating constructor. Its actual pure readers
    # and committed verifier still validate every original source/note snapshot.
    store = Store.__new__(Store)
    store.root = root
    store.system = root / 'System'
    store.journal = store.system / 'Changes'
    for file in [root, *root.parents, store.system, store.journal]:
        safe(file)
        assert file.is_dir()
    turn = cfg['turn']
    folder = store.system / 'Capture' / turn['id']
    manifest = store.journal / turn['id'] / 'manifest.json'
    for file in [folder, manifest.parent, folder / 'input.json', manifest]:
        safe(file)
    raw = image(folder / 'input.json')
    body = json.loads(raw)
    assert validate(body) == raw and body['format'] == 'raya.memory.capture.v3'
    assert body['id'] == turn['id'] and body['project'] == turn['project']
    assert body['session'] == turn['sessionID'] and body['message'] == turn['messageID']
    assert body['source_sha256'] == turn['source_sha256']
    original = image(manifest)
    state = committed(store, turn['id'], digest(raw))
    result = dict(id=state['id'], status='committed', duplicate=False,
                  note_sha256={row['path']: row['new_sha256'] for row in state['changes']},
                  input_sha256=digest(raw))
    assert fingerprint(result) == cfg['resultSHA']

    file = store.system / 'general-admission.json'
    policy = image(file)
    value = json.loads(policy)
    assert serialize(value) == policy and value['revision'] > 1
    selected = Policy(value)
    selected.bind(root)
    for row in value['files']:
        if row['review'] == 'approved':
            note = root
            for part in row['relative'].split('/'):
                note = note / part
                safe(note)
            selected.verify(row['relative'], store.current(note))
    prior = json.loads(policy)
    prior['revision'] -= 1
    records = {row['relative'].casefold(): row for row in prior['files']}
    for row in state['changes']:
        name = row['path'].casefold()
        assert records[name] == dict(relative=row['path'], sha256=row['new_sha256'],
                                     classification='general', review='approved')
        if row['old_sha256'] is None:
            del records[name]
        else:
            records[name]['sha256'] = row['old_sha256']
    prior['files'] = list(records.values())
    Policy(prior).bind(root)
    expected = digest(serialize(prior))
    assert fingerprint(dict(publication=body, expected_policy_sha256=expected)) == cfg['bodySHA']
    assert image(file) == policy and image(manifest) == original and image(folder / 'input.json') == raw
    assert committed(store, turn['id'], digest(raw)) == state
    return dict(format='raya.memory.committed-capture.review', version=1,
                capture=turn['id'], inputSHA=digest(raw), journalSHA=digest(original),
                policySHA=digest(policy), previousPolicySHA=expected, result=result,
                requestSettlement=False, replay=False, indexConfirmed=False)


if __name__ == '__main__':
    try:
        assert len(sys.argv) == 2 and len(sys.argv[1].encode()) <= 8192
        print(json.dumps(review(json.loads(sys.argv[1])), sort_keys=True, separators=(',', ':')))
    except Exception:
        print('Committed capture evidence could not be verified.', file=sys.stderr)
        sys.exit(1)
