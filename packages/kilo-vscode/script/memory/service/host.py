"""Trusted host primitives only. No HTTP/CLI approval, reset, capture or inference.

The installed host must authenticate a genuine human UI action before approve().
Caller JSON labels, a preview hash and importing this module are not consent.
"""
import copy
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import threading
import time
import uuid
from admission import Store, Refused, Retirement, image, serialize
from policy import Policy


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


class Host:
    def __init__(self, root, *, existing=False, generation=None):
        self.store = Store(root, existing=existing, generation=generation)
        self.guard = threading.Lock()
        self.previews = {}

    def state(self):
        self.store.check()
        if not os.path.lexists(self.store.file):
            return None, {'format': 'raya-general-sources-v1', 'root': str(self.store.root),
                          'enabled': False, 'revision': 0, 'files': []}
        raw = image(self.store.file)
        value = json.loads(raw.decode('utf-8-sig'))
        if Policy(value).root != self.store.root:
            raise Refused('Stored policy belongs to another root; trusted inspection is required.')
        self.store.check()
        return hashlib.sha256(raw).hexdigest(), value

    def source(self, name):
        # Validate the explicit prospective general route before reading bytes.
        Policy({'format': 'raya-general-sources-v1', 'root': str(self.store.root),
                'enabled': False, 'revision': 1, 'files': [{'relative': name,
                'sha256': '0' * 64, 'classification': 'general', 'review': 'proposed'}]})
        ignore = self.store.root / '.rayaignore'
        if os.path.lexists(ignore):
            patterns = [line.strip().casefold() for line in image(ignore).decode('utf-8').splitlines()
                        if line.strip() and not line.startswith('#')]
            if any(fnmatch.fnmatch(name.casefold(), pattern) for pattern in patterns):
                raise Refused('Selected source is excluded; no bytes were reviewed.')
        path = self.store.root
        for part in name.split('/'):
            path = path / part
            if path.is_symlink() or path.is_junction():
                raise Refused('A selected source contains a linked path.')
        raw = image(path)
        if len(raw) > 65536:
            raise Refused('Selected source exceeds the exact review size limit.')
        try:
            text = raw.decode('utf-8')
        except UnicodeDecodeError as err:
            raise Refused('Selected source must be exact UTF-8 text.') from err
        self.store.check()
        return {'relative': name, 'sha256': hashlib.sha256(raw).hexdigest(),
                'bytes': len(raw), 'text': text, 'classification': 'general', 'review': 'proposed'}

    def preview(self, names, enabled=False):
        """Read selected bytes only; do not copy them durably or change policy."""
        if (not isinstance(names, list) or not 1 <= len(names) <= 128
                or any(not isinstance(name, str) for name in names)
                or len({name.casefold() for name in names}) != len(names)
                or type(enabled) is not bool):
            raise Refused('Select distinct bounded source names and explicit enablement.')
        with self.guard, self.store.locked():
            now = time.monotonic()
            self.previews = {key: row for key, row in self.previews.items() if row['until'] > now}
            if len(self.previews) >= 8:
                raise Refused('Review queue is full; discard an earlier review.')
            sha, prior = self.state()
            sources = [self.source(name) for name in names]
            if sum(row['bytes'] for row in sources) > 262144:
                raise Refused('Combined exact source review exceeds 256 KiB.')
            value = {'format': 'raya-general-sources-v1', 'root': str(self.store.root),
                     'enabled': enabled, 'revision': prior['revision'] + 1,
                     'files': [{key: row[key] for key in ('relative', 'sha256', 'classification')}
                               | {'review': 'approved'} for row in sources]}
            plan = {'format': 'raya-general-review-v1', 'id': str(uuid.uuid4()),
                    'expected_policy_sha256': sha, 'prior': prior, 'sources': sources,
                    'policy': value, 'namespace': self.store.expected,
                    'prospective_policy_sha256': hashlib.sha256(serialize(value)).hexdigest(),
                    'ignore_sha256': self.ignore(),
                    'effect': 'Replace the complete source allowlist; omitted sources are removed. No sync or model request.'}
            raw = encode(plan)
            digest = hashlib.sha256(raw).hexdigest()
            self.previews[plan['id']] = {'raw': raw, 'sha': digest, 'until': now + 900}
            return copy.deepcopy({'preview': plan, 'preview_sha256': digest, 'expires_seconds': 900})

    def ignore(self):
        path = self.store.root / '.rayaignore'
        return hashlib.sha256(image(path)).hexdigest() if os.path.lexists(path) else None

    def discard(self, key):
        with self.guard:
            return self.previews.pop(key, None) is not None

    def approve(self, key, expected):
        """Only an authenticated human action may call this trusted primitive.

        key/hash must be retained by the host that presented preview(), never
        replaced with a model/webview-supplied plan or newly computed hash.
        """
        with self.guard:
            row = self.previews.get(key)
            if row is None or row['until'] <= time.monotonic() or expected != row['sha']:
                raise Refused('Exact retained review is absent, expired or different.')
            plan = json.loads(row['raw'])
            def gate():
                if self.store.expected != plan['namespace']:
                    raise Refused('Reviewed namespace changed.')
                if self.ignore() != plan['ignore_sha256']:
                    raise Refused('Reviewed exclusion policy changed; review again.')
                for source in plan['sources']:
                    current = self.source(source['relative'])
                    if current != source:
                        raise Refused('Displayed source bytes changed; review again.')
                if self.store.pending():
                    raise Retirement('Unconfirmed retrieval blocks review publication.')
            sha = self.store.replace(plan['policy'], plan['expected_policy_sha256'], gate=gate)
            del self.previews[key]
            return {'status': 'policy_published', 'policy_sha256': sha,
                    'revision': plan['policy']['revision'], 'enabled': plan['policy']['enabled'],
                    'sync_started': False, 'capture_enabled': False}

    def pause(self, expected):
        """Host fences new intake and joins its jobs before invoking this.

        Busy or uncertain retirement is unaccepted, never an acknowledged pause.
        No downstream reset/cancel/stop operation is performed here.
        """
        with self.guard:
            sha, value = self.state()
            if sha is None or expected != sha:
                raise Refused('Pause policy revision conflict or missing policy.')
            value = dict(value, enabled=False, revision=value['revision'] + 1)
            def gate():
                if self.store.pending():
                    raise Retirement('Pause retirement is unconfirmed; not accepted.')
            final = self.store.replace(value, sha, gate=gate)
            self.previews.clear()
            return {'status': 'policy_disabled', 'policy_sha256': final,
                    'revision': value['revision'], 'enabled': False, 'capture_enabled': False,
                    'host_join_required': True}
