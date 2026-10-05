"""Pure diagnostic and filesystem tests; never import a selected service."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest

import supervise


class Phases(unittest.TestCase):
    def test_bounded_public_phase(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            supervise.phase('closure-verified')
            supervise.phase('control-eof')
        rows = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([row['phase'] for row in rows], ['closure-verified', 'control-eof'])
        self.assertTrue(all(set(row) == {'format', 'phase', 'elapsed'} for row in rows))
        self.assertTrue(all(row['format'] == 'raya.memory.disposable.supervisor.phase' for row in rows))
        self.assertGreaterEqual(rows[0]['elapsed'], 0)
        self.assertGreaterEqual(rows[1]['elapsed'], rows[0]['elapsed'])
        self.assertLess(len(output.getvalue()), 512)

    def test_arbitrary_phase_refused(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), self.assertRaisesRegex(ValueError, 'Unknown supervisor phase'):
            supervise.phase('private request body')
        self.assertEqual(output.getvalue(), '')

    def test_genuine_dependency_verification(self):
        with tempfile.TemporaryDirectory(prefix='raya-supervisor-phase-') as folder:
            path = Path(folder).resolve() / 'source.py'
            path.write_bytes(b'unchanged synthetic source\n')
            info = path.lstat()
            row = {'path': str(path), 'bytes': info.st_size,
                   'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                   'identity': [getattr(info, key) for key in
                                ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')]}
            self.assertEqual(supervise.verify(row, True), path.read_bytes())
            self.assertIsNone(supervise.verify(row, False))
            path.write_bytes(b'changed synthetic source\n')
            with self.assertRaisesRegex(ValueError, 'Planned dependency identity differs'):
                supervise.verify(row, True)


if __name__ == '__main__':
    unittest.main()
