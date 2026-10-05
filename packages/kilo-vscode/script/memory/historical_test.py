"""Actual protected Journal publications and a fresh metadata-only Python process."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import unittest
from namespace_publication_test import Tests as NamespaceTests, MODULE, HERE

sys.modules['namespace'] = MODULE
sys.path.insert(0, str(HERE / 'service'))
from operations import Journal
from retirement import canonical, fingerprint
from historical import capture, inspect, restore


class Tests(NamespaceTests):
    def operation(self, outcome='completed', kind='search'):
        self.folder.rmdir()
        names = ('server.py', 'index.py', 'notes.py', 'policy.py', 'admission.py',
                 'host.py', 'operations.py', 'retirement.py', 'namespace.py', 'historical.py', 'dispatch.py')
        self.source = {name: hashlib.sha256((HERE / 'service' / name).read_bytes()).hexdigest() for name in names}
        self.journal = Journal(str(self.root), self.sid,
                               {name: MODULE.generation(self.root if name == 'root' else self.root / name) for name in ('root', 'Runs', 'Requests')},
                               'e' * 32, fingerprint(self.source))
        pending = self.journal.reserve('1' * 32, kind, {'query': 'synthetic violet', 'top': 5})
        selected = capture(self.journal, pending, self.source)
        if outcome is None:
            return selected
        result = {'results': [], 'capture_enabled': False} if kind == 'search' else {'files': 1, 'chunks': 0, 'new_embeddings': 0, 'reused_embeddings': 0}
        self.journal.complete(pending, result, outcome, [])
        return selected

    def test_original_terminal_and_new_process(self):
        selected = self.operation()
        result = inspect(selected)
        self.assertEqual(result['operation']['operation_outcome'], 'completed')
        self.assertFalse(result['coldAdmission'])
        record = selected.record()
        self.assertTrue(all(isinstance(part, str) for row in record['generations'].values() for part in row))
        self.assertTrue(any(int(row[0]) > 2**53 for row in record['generations'].values()))
        script = """import json,sys
sys.path.insert(0,sys.argv[1])
from namespace import Namespace
from historical import restore,inspect,decimal
value=json.loads(sys.stdin.buffer.read())
namespace=Namespace(sys.argv[2],sys.argv[3],{name:[decimal(part) for part in row] for name,row in value['generations'].items()})
result=inspect(restore(namespace,value))
print(json.dumps({'completed':result['operation']['operation_outcome']=='completed','coldAdmission':result['coldAdmission']}))
"""
        child = subprocess.Popen([sys.executable, '-I', '-S', '-B', '-c', script, str(HERE / 'service'), str(self.root), self.sid],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=0x08000000)
        out, err = child.communicate(canonical(record))
        self.assertEqual(child.returncode, 0, err.decode())
        self.assertEqual(json.loads(out), {'completed': True, 'coldAdmission': False})
        self.assertEqual(inspect(selected), result)

    def test_sync_aggregate(self):
        self.assertEqual(inspect(self.operation(kind='sync'))['operation']['counts']['files'], 1)

    def test_inert_record_cannot_select_namespace(self):
        selected = self.operation()
        with self.assertRaises(ValueError):
            inspect(selected.record())
        self.assertEqual(inspect(restore(self.journal.namespace, selected.record()))['operation']['status'], 'terminal')

    def test_pending_failed_cancelled_remain_refused(self):
        selected = self.operation(outcome=None)
        with self.assertRaises(FileNotFoundError):
            inspect(selected)
        pending = selected.record()['pending']
        terminal = self.journal.complete(pending, None, 'failed', [])
        with self.assertRaises(ValueError):
            inspect(selected)
        terminal['operation_outcome'] = 'cancelled'
        terminal['receipt_sha256'] = fingerprint({key: item for key, item in terminal.items() if key != 'receipt_sha256'})
        (self.journal.folder / ('1' * 32 + '-terminal.json')).write_bytes(canonical(terminal))
        with self.assertRaises(ValueError):
            inspect(selected)

    def test_original_pending_replacement_refused(self):
        selected = self.operation()
        file = self.journal.folder / ('1' * 32 + '-pending.json')
        raw = file.read_bytes()
        file.unlink()
        file.write_bytes(raw)
        with self.assertRaises(ValueError):
            inspect(selected)

    def test_wrong_identity_body_or_source_refused(self):
        selected = self.operation()
        for field in ('request', 'owner_epoch', 'request_sha256', 'selected_release_sha256'):
            record = selected.record()
            record['pending'][field] = '0' * len(record['pending'][field])
            with self.assertRaises((ValueError, FileNotFoundError)):
                inspect(restore(self.journal.namespace, record))
        record = selected.record()
        record['source_sha256']['server.py'] = '0' * 64
        with self.assertRaises(ValueError):
            inspect(restore(self.journal.namespace, record))

    def test_uint64_and_namespace_generation_refused(self):
        selected = self.operation()
        for value in ('01', '-1', '18446744073709551616', 123, '1.0'):
            record = selected.record()
            record['generations']['root'][0] = value
            with self.assertRaises(ValueError):
                restore(self.journal.namespace, record)
        record = selected.record()
        record['generations']['root'][1] = str(int(record['generations']['root'][1]) + 1)
        with self.assertRaises(ValueError):
            restore(self.journal.namespace, record)

    def test_corrupt_duplicate_and_unjoined_terminal_refused(self):
        selected = self.operation()
        file = self.journal.folder / ('1' * 32 + '-terminal.json')
        raw = file.read_bytes()
        file.write_bytes(b'{"status":"terminal","status":"terminal"}')
        with self.assertRaises(ValueError):
            inspect(selected)
        value = json.loads(raw)
        value['downstream'] = [{'request': 'f' * 32, 'owner_epoch': 'a' * 32,
                                'selected_release_sha256': 'b' * 64, 'request_sha256': 'c' * 64,
                                'cleanup_outcome': 'unconfirmed'}]
        value['receipt_sha256'] = fingerprint({key: item for key, item in value.items() if key != 'receipt_sha256'})
        file.write_bytes(canonical(value))
        with self.assertRaises((ValueError, KeyError)):
            inspect(selected)

    def test_unrelated_valid_retirement_cannot_authorize_parent(self):
        selected = self.operation(outcome=None)
        proof = {'format': 'raya.retrieval.retirement', 'version': 1,
                 'request': 'a' * 32, 'owner_epoch': 'b' * 32,
                 'selected_release_sha256': 'c' * 64,
                 'request_sha256': 'd' * 64, 'phase': 'retired',
                 'worker_created': False, 'cleanup_outcome': 'not_started',
                 'joins_observed': False, 'queued_never_created': True,
                 'inference_outcome': 'completed', 'result_sha256': 'e' * 64}
        proof['receipt_sha256'] = fingerprint(proof)
        # Actual Journal.complete validates and publishes this self-consistent
        # certificate. Historical inspection still refuses unrelated authority.
        self.journal.complete(selected.record()['pending'], {'results': [], 'capture_enabled': False}, 'completed', [proof])
        with self.assertRaisesRegex(ValueError, 'Independent original downstream'):
            inspect(selected)

    def test_mutable_selection_and_malformed_dicts_remain_inert(self):
        selected = self.operation()
        for field, value in (('source_sha256', []), ('generations', []), ('pending', []), ('epoch_generation', [1, 2, 3])):
            record = selected.record()
            record[field] = value
            with self.assertRaises(ValueError):
                inspect(restore(self.journal.namespace, record))
        record = selected.record()
        record['source_sha256']['invented.py'] = 'f' * 64
        with self.assertRaises(ValueError):
            restore(self.journal.namespace, record)
        selected.value['pending']['request_sha256'] = 'f' * 64
        with self.assertRaises(ValueError):
            inspect(selected)

    def test_capture_rejects_traversal_before_outside_epoch_read(self):
        selected = self.operation(outcome=None)
        pending = selected.record()['pending']
        pending['request'] = '../escape'
        outside = self.root / 'Requests' / 'escape-pending.json'
        raw = canonical(pending)
        outside.write_bytes(raw)
        MODULE.acl(outside, self.sid)
        # The old capture constructed epoch/../escape-pending.json and accepted
        # this actual same-ACL file. Validation now rejects before construction.
        with self.assertRaisesRegex(ValueError, 'Historical original request'):
            capture(self.journal, pending, self.source)
        self.assertEqual(outside.read_bytes(), raw)
        for field, value in (('request', []), ('owner_epoch', '../escape'), ('kind', []), ('status', 'terminal'), ('request_sha256', '0'), ('selected_release_sha256', [])):
            pending = selected.record()['pending']
            pending[field] = value
            with self.assertRaises(ValueError):
                capture(self.journal, pending, self.source)


# Keep the three inherited publication regressions, but do not discover the
# imported base TestCase again as a separate copy of those tests.
del NamespaceTests

if __name__ == '__main__':
    unittest.main()
