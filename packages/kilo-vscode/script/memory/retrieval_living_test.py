"""Actual Windows child/job/source observations; no model or service activation."""
import ctypes
from ctypes import wintypes as w
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parent / 'retrieval'))
from lease import Lease
from living import accept, observe
from owner import api, checked, Extended, identity, Process, selected, SIZE
from validation import fingerprint

PYTHON = Path(r'D:/Raya/Services/Packaging/Python/3.12.14/python.exe')


@unittest.skipUnless(os.name == 'nt', 'Actual Windows handles required')
class Tests(unittest.TestCase):
    def setUp(self):
        self.library = api()
        self.library.TerminateJobObject.argtypes = [w.HANDLE, w.UINT]
        self.library.TerminateJobObject.restype = w.BOOL
        self.job = checked(self.library.CreateJobObjectW(None, None), 'CreateJobObjectW_test')
        self.process = Process()
        self.addCleanup(self.retire)
        size = SIZE()
        self.library.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
        self.assertEqual(ctypes.get_last_error(), 122)
        buffer = ctypes.create_string_buffer(size.value)
        checked(self.library.InitializeProcThreadAttributeList(buffer, 1, 0, ctypes.byref(size)), 'InitializeProcThreadAttributeList_test')
        try:
            jobs = (w.HANDLE * 1)(self.job)
            checked(self.library.UpdateProcThreadAttribute(buffer, 0, 0x2000d, jobs, ctypes.sizeof(jobs), None, None), 'UpdateProcThreadAttribute_JOB_LIST_test')
            startup = Extended()
            startup.startup.size = ctypes.sizeof(Extended)
            startup.attributes = ctypes.cast(buffer, w.LPVOID)
            command = ctypes.create_unicode_buffer(subprocess.list2cmdline([
                str(PYTHON), '-I', '-S', '-B', '-c', 'import time; time.sleep(30)']))
            checked(self.library.CreateProcessW(str(PYTHON), command, None, None, False,
                    0x80000 | 0x08000000, None, None, ctypes.byref(startup), ctypes.byref(self.process)), 'CreateProcessW_test')
        finally:
            self.library.DeleteProcThreadAttributeList(buffer)
        self.birth = identity(self.library, self.process.process)
        digest = hashlib.sha256(PYTHON.read_bytes()).hexdigest()
        self.images = {'interpreter': {'path': PYTHON, 'sha256': digest, 'observed': selected(PYTHON, digest)}}

    def retire(self):
        checked(self.library.TerminateJobObject(self.job, 0), 'TerminateJobObject_test')
        if self.process.process:
            self.assertEqual(self.library.WaitForSingleObject(self.process.process, 10000), 0)
        for handle in (self.process.thread, self.process.process, self.job):
            if handle:
                checked(self.library.CloseHandle(handle), 'CloseHandle_test')

    def test_retained_process_and_creation_time_job(self):
        value = observe(self.library, self.process.process, self.job, self.birth, self.images)
        self.assertTrue(value['original_process_running'])
        self.assertTrue(value['original_job_membership_observed'])
        self.assertEqual(value['worker'], self.birth)
        self.assertNotIn('joins_observed', value)

    def test_wrong_birth_and_job_refused(self):
        with self.assertRaisesRegex(ValueError, 'live_process_identity_changed'):
            observe(self.library, self.process.process, self.job, {**self.birth, 'birth_filetime': '0'}, self.images)
        other = checked(self.library.CreateJobObjectW(None, None), 'CreateJobObjectW_other_test')
        try:
            with self.assertRaisesRegex(ValueError, 'live_original_job_membership'):
                observe(self.library, self.process.process, other, self.birth, self.images)
        finally:
            checked(self.library.CloseHandle(other), 'CloseHandle_other_test')

    def test_exit_refused_using_original_handle(self):
        checked(self.library.TerminateJobObject(self.job, 0), 'TerminateJobObject_exit_test')
        self.assertEqual(self.library.WaitForSingleObject(self.process.process, 10000), 0)
        with self.assertRaisesRegex(ValueError, 'live_process_not_running'):
            observe(self.library, self.process.process, self.job, self.birth, self.images)

    def test_changed_selected_source_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'source.py'
            path.write_bytes(b'original')
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            images = {**self.images, 'source': {'path': path, 'sha256': digest, 'observed': selected(path, digest)}}
            self.assertTrue(observe(self.library, self.process.process, self.job, self.birth, images)['selected_images_unchanged'])
            path.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'source_selection|live_selected_image_changed'):
                observe(self.library, self.process.process, self.job, self.birth, images)

    def test_completion_requires_bound_result_and_native_observation(self):
        parent = Lease('1' * 32, '2' * 32, 'a' * 64, 'embeddings', 'embeddinggemma-2')
        body = {'model': 'embeddinggemma-2', 'input': ['fixture']}
        parent.request({'format': 'raya.retrieval.lease.request', 'version': 2,
                        'lease': parent.lease, 'owner_epoch': parent.epoch,
                        'selected_release_sha256': parent.release, 'sequence': 1,
                        'request': '3' * 32, 'request_sha256': fingerprint(body),
                        'kind': parent.kind, 'body': body})
        output = {'object': 'list', 'model': parent.model, 'revision': 'fixture-revision',
                  'dimensions': 768, 'normalized': True,
                  'data': [{'object': 'embedding', 'index': 0, 'embedding': [1.0] + [0.0] * 767}],
                  'timing': {'seconds': 0.1}}
        frame = {**parent.current, 'format': 'raya.retrieval.lease.completion', 'result': output}
        for changed in [{**frame, 'owner_epoch': '4' * 32}, {**frame, 'sequence': True},
                        {**frame, 'result': {**output, 'revision': 'wrong'}}]:
            with self.assertRaises(ValueError):
                accept(parent, body, changed, 'fixture-revision', self.library,
                       self.process.process, self.job, self.birth, self.images)
            self.assertIsNotNone(parent.current)
        with self.assertRaisesRegex(ValueError, 'live_completion_identity'):
            accept(parent, {**body, 'input': ['changed']}, frame, 'fixture-revision', self.library,
                   self.process.process, self.job, self.birth, self.images)
        with self.assertRaisesRegex(ValueError, 'live_process_identity_changed'):
            accept(parent, body, frame, 'fixture-revision', self.library,
                   self.process.process, self.job, {**self.birth, 'birth_filetime': '0'}, self.images)
        self.assertIsNotNone(parent.current)
        value, receipt = accept(parent, body, frame, 'fixture-revision', self.library,
                                self.process.process, self.job, self.birth, self.images)
        self.assertIs(value, output)
        self.assertIsNone(parent.current)
        self.assertEqual(receipt['request'], '3' * 32)
        self.assertEqual(receipt['format'], 'raya.retrieval.lease.observation')
        self.assertNotIn('joins_observed', receipt)
        with self.assertRaisesRegex(ValueError, 'live_completion_identity'):
            accept(parent, body, frame, 'fixture-revision', self.library,
                   self.process.process, self.job, self.birth, self.images)


if __name__ == '__main__':
    unittest.main()
