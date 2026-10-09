import copy
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
import wave

HERE = Path(__file__).resolve().parents[2] / 'script/memory/media'
sys.path.insert(0, str(HERE))
from session import Session, encode, debt
from supervisor import joined
from worker import execute, checkpoint


class Contract(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='raya-media-contract-')
        self.base = Path(self.temp.name).resolve()
        self.project = self.base / 'workspace'
        self.source = self.base / 'personal'
        self.root = self.base / 'library'
        for path in (self.project, self.source, self.root):
            path.mkdir()
        raw = io.BytesIO()
        with wave.open(raw, 'wb') as file:
            file.setnchannels(1)
            file.setsampwidth(2)
            file.setframerate(16000)
            file.writeframes(b'\0\0' * 16000)
        self.raw = raw.getvalue()
        self.path = self.source / 'approved.wav'
        self.path.write_bytes(self.raw)
        self.hash = hashlib.sha256(self.raw).hexdigest()
        self.selection = dict(format='raya.media.selection.v1', project=str(self.project), source=str(self.source), root=str(self.root), excluded=[], files=[dict(path=str(self.path), sha256=self.hash, bytes=len(self.raw), kind='audio', title='Approved fixture')])

    def tearDown(self):
        self.temp.cleanup()

    def request(self, op):
        return dict(format='raya.media.operation.v1', request=uuid.uuid4().hex, epoch=uuid.uuid4().hex, release='a' * 64, policySHA=hashlib.sha256(encode(self.selection)).hexdigest(), op=op, selection=copy.deepcopy(self.selection), args=dict(id=self.hash), model=None)

    def test_actual_wav_inspect_import_forget_and_no_automatic_replay(self):
        inspected = execute(self.request('inspect'))
        self.assertEqual(inspected['result']['decoded']['segments'], [dict(start=0.0, end=1.0)])
        value = self.request('import')
        imported = execute(value)
        self.assertEqual(imported['status'], 'completed')
        self.assertFalse(imported['authority'])
        self.assertFalse(imported['result']['indexed'])
        snapshot = Path(imported['result']['snapshot']['path'])
        self.assertEqual(snapshot.read_bytes(), self.raw)
        self.assertEqual(imported['result']['origin'], str(self.path))
        self.assertEqual(imported['result']['sourceSHA'], self.hash)
        self.assertEqual(imported['result']['decoded']['duration'], 1.0)
        with self.assertRaisesRegex(ValueError, 'automatic replay'):
            execute(value)
        forgotten = execute(self.request('forget'))
        self.assertEqual(forgotten['status'], 'completed')
        self.assertTrue(forgotten['result']['forgotten'])
        self.assertFalse(snapshot.exists())
        self.assertEqual(self.path.read_bytes(), self.raw)
        self.assertNotIn('encoder', sys.modules)
        self.assertNotIn('torch', sys.modules)

    def test_unfinished_request_blocks_other_owner_epoch(self):
        value = self.request('import')
        session = Session(value)
        with self.assertRaisesRegex(ValueError, 'automatic replay'):
            execute(self.request('import'))
        self.assertTrue(session.pending.exists())
        self.assertFalse(session.terminal.exists())
        self.assertEqual(json.loads(session.lock.read_text())['request'], value['request'])
        session.lock.unlink()
        with self.assertRaisesRegex(ValueError, 'Unfinished original'):
            execute(self.request('inspect'))

    def test_stop_checkpoint_binds_original_pending_bytes(self):
        value = self.request('inspect')
        session = Session(value)
        session.stop()
        with self.assertRaises(InterruptedError):
            checkpoint(value)
        session.pending.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'identity'):
            checkpoint(value)

    def test_retired_history_does_not_reread_changed_original_sources(self):
        session = Session(self.request('inspect'))
        session.finish('completed', {})
        self.path.write_bytes(b'original no longer exists at that revision')
        debt(session.root)
        with self.assertRaisesRegex(ValueError, 'revision'):
            execute(self.request('inspect'))

    def test_audit_cas_preserves_uncertainty_on_changed_pending(self):
        session = Session(self.request('import'))
        session.pending.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'CAS'):
            session.finish('completed', {})
        self.assertTrue(session.lock.exists())
        self.assertFalse(session.terminal.exists())

    def test_orphan_audit_and_changed_original_bindings_refuse_new_generations(self):
        for suffix in ('stop', 'terminal'):
            with self.subTest(suffix=suffix):
                root = self.base / suffix
                root.mkdir()
                folder = root / uuid.uuid4().hex
                folder.mkdir()
                (folder / (uuid.uuid4().hex + '.' + suffix + '.json')).write_bytes(b'{}')
                with self.assertRaisesRegex(ValueError, 'Orphan'):
                    debt(root)
        session = Session(self.request('inspect'))
        session.stop()
        session.finish('completed', {})
        debt(session.root)
        row = json.loads(session.terminal.read_bytes())
        row['release'] = 'b' * 64
        session.terminal.write_bytes(encode(row))
        with self.assertRaisesRegex(ValueError, 'terminal'):
            debt(session.root)
        row['release'] = session.value['release']
        session.terminal.write_bytes(encode(row))
        stop = session.dir / (session.value['request'] + '.stop.json')
        row = json.loads(stop.read_bytes())
        row['pendingSHA'] = '0' * 64
        stop.write_bytes(encode(row))
        with self.assertRaisesRegex(ValueError, 'STOP'):
            debt(session.root)

    def test_joined_rejects_malformed_native_ownership_without_coercion(self):
        for value in (None, [], {}, {'creation': None}, {'creation': [], 'outputs': []},
                      {'creation': {}, 'outputs': None}, {'cleanup_outcome': 'joined'}):
            with self.subTest(value=value):
                self.assertFalse(joined(value))

    def test_original_hash_exclusions_and_source_escape_fail_before_publication(self):
        value = self.request('import')
        value['selection']['files'][0]['sha256'] = '0' * 64
        with self.assertRaises(ValueError):
            execute(value)
        self.assertFalse((self.root / 'Requests').exists())
        for field, replacement in [('source', str(self.project)), ('excluded', [str(self.source)])]:
            value = self.request('import')
            value['selection'][field] = replacement
            value['policySHA'] = hashlib.sha256(encode(value['selection'])).hexdigest()
            with self.assertRaises(ValueError):
                execute(value)
        self.assertFalse((self.root / 'Requests').exists())


if __name__ == '__main__':
    unittest.main()
