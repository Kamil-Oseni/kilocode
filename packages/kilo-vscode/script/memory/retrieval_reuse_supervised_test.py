"""Actual protected candidate START/health/STOP; no inference or installed deployment."""
import ast
import ctypes
import hashlib
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import threading
import time
import unittest
import urllib.request
import urllib.error
import uuid
import retrieval_reuse_entry_test as entry

SOURCE = Path(__file__).parent
CANDIDATE = Path('D:/Raya/Services/Retrieval/Candidates/GemmaText-20261006-root')
KEYS = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def row(path):
    info = path.lstat()
    with path.open('rb') as file:
        opened = os.fstat(file.fileno())
        digest = hashlib.file_digest(file, 'sha256').hexdigest()
        final = os.fstat(file.fileno())
    after = path.lstat()
    stamp = lambda value: tuple(getattr(value, key) for key in KEYS)
    assert stamp(info) == stamp(after) and stamp(opened) == stamp(final)
    assert all(stamp(info)[index] == stamp(opened)[index] for index in (0, 1, 2, 3, 5))
    return {'path': str(path), 'bytes': info.st_size, 'sha256': digest,
            'identity': [getattr(info, key) for key in KEYS]}


def available():
    class Status(ctypes.Structure):
        _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong)] + [
            (name, ctypes.c_ulonglong) for name in ('total', 'free', 'paging', 'available_paging',
                                                   'virtual', 'available_virtual', 'extended')]
    value = Status()
    value.length = ctypes.sizeof(value)
    library = ctypes.WinDLL('kernel32', use_last_error=True)
    library.GlobalMemoryStatusEx.argtypes = [ctypes.POINTER(Status)]
    library.GlobalMemoryStatusEx.restype = ctypes.c_int
    if not library.GlobalMemoryStatusEx(ctypes.byref(value)):
        raise OSError(ctypes.get_last_error(), 'GlobalMemoryStatusEx')
    return value.free


@unittest.skipUnless(os.environ.get('RAYA_REUSE_API_TEST_ADMITTED') == 'GemmaText-20261006-root',
                     'Candidate dependencies require explicit admission')
class Tests(unittest.TestCase):
    cleanup = entry.Tests.cleanup
    restore = entry.Tests.restore
    retire = entry.Tests.retire
    fence = entry.Tests.fence

    def setUp(self):
        entry.Tests.setUp(self)

    def test_protected_original_start_health_stop_without_inference(self):
        manifest = CANDIDATE/'dependency-images.json'
        self.assertEqual(sha(manifest.read_bytes()), 'd2d6de6f5af6b69dd27b48607cba41614491612cb373c9eaab8780b617eae705')
        inventory = json.loads(manifest.read_bytes())
        deps = self.capsule/'dependencies'
        for item in inventory['images']:
            source = CANDIDATE/'venv'/'Lib'/'site-packages'/item['relative']
            self.assertEqual(source.stat().st_size, item['bytes'])
            target = deps/item['relative']
            self.assertTrue(target.resolve().is_relative_to(deps))
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            self.assertEqual(row(target)['sha256'], item['sha256'])
        supervisor = self.capsule/'supervise.py'
        shutil.copyfile(SOURCE/'supervise.py', supervisor)
        pins = next(ast.literal_eval(node.value) for node in ast.parse(supervisor.read_bytes()).body
                    if isinstance(node, ast.Assign) and any(isinstance(key, ast.Name) and key.id == 'REUSE'
                                                           for key in node.targets))
        files = [row(file) for folder in ('source', 'python', 'dependencies')
                 for file in (self.capsule/folder).rglob('*') if file.is_file()]
        token = Path(self.env['RAYA_RETRIEVAL_TOKEN_FILE'])
        token.write_text(uuid.uuid4().hex+uuid.uuid4().hex, encoding='ascii')
        files += [row(token), row(supervisor)]
        # Observe every copied directory and file with the actual Windows ACL validator.
        paths = [self.capsule, *self.capsule.rglob('*')]
        for path in paths:
            entry.fixture.MODULE.acl(path, self.sid)
        proof = self.capsule/'protection.json'
        proof.write_text(json.dumps({'passed': True, 'root': str(self.capsule),
                                    'observed_acl_paths': len(paths), 'models_admitted': False}), encoding='utf-8')
        env = dict(self.env, RAYA_RETRIEVAL_PORT='59943', HOME=str(self.capsule/'home'),
                   USERPROFILE=str(self.capsule/'home'), TEMP=str(self.capsule/'tmp'), TMP=str(self.capsule/'tmp'),
                   HF_HOME=str(self.capsule/'hf'), HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
                   PYTHONDONTWRITEBYTECODE='1', SystemRoot=os.environ['SystemRoot'])
        plan = {'format': 'raya.memory.managed.supervisor', 'version': 1, 'kind': 'retrieval',
                'root': str(self.capsule), 'execution_admitted': True,
                'retrieval_protocol': 'raya.retrieval.request.settlement.v2',
                'python_sha256': row(self.capsule/'python'/'python.exe')['sha256'],
                'source': str(self.capsule/'source'), 'source_sha256': pins,
                'dependencies': str(deps), 'files': files, 'env': env, 'port': 59943,
                'directories': [{'path': str(path), 'identity': [path.stat().st_dev, path.stat().st_ino,
                                                               path.stat().st_ctime_ns]}
                                for folder in ('source', 'python', 'dependencies')
                                for path in [self.capsule/folder, *(self.capsule/folder).rglob('*')]
                                if path.is_dir()],
                'protection': {'path': str(proof), 'sha256': sha(proof.read_bytes())}}
        target = self.capsule/'retrieval.json'
        target.write_text(json.dumps(plan), encoding='utf-8')
        child = subprocess.Popen([str(self.capsule/'python'/'python.exe'), '-I', '-S', '-B', '-u',
                                  str(supervisor), '--managed', str(target), sha(target.read_bytes())],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 creationflags=0x08000000)
        lines, errors, events = [], [], queue.Queue()
        def read(stream, saved, publish=False):
            for raw in iter(stream.readline, b''):
                saved.append(raw)
                if publish:
                    events.put(json.loads(raw))
        readers = [threading.Thread(target=read, args=(child.stdout, lines, True)),
                   threading.Thread(target=read, args=(child.stderr, errors))]
        for reader in readers:
            reader.start()
        samples = []
        faults = []
        sampling = threading.Event()
        begun = time.monotonic()
        def sample():
            try:
                while not sampling.is_set():
                    samples.append({'elapsed': time.monotonic()-begun, 'available_bytes': available()})
                    sampling.wait(0.1)
            except BaseException as error:
                faults.append(error)
        sampler = threading.Thread(target=sample)
        sampler.start()
        phases = []
        health = None
        lifecycle = []
        failure = None
        try:
            until = time.monotonic()+30
            while time.monotonic() < until:
                value = events.get(timeout=max(0.01, until-time.monotonic()))
                phases.append(value)
                if value.get('phase') == 'launch-selected':
                    child.stdin.write(b'START\n')
                    child.stdin.flush()
                if value.get('phase') == 'uvicorn-started':
                    break
            else:
                self.fail('Original supervisor startup observation expired')
            request = urllib.request.Request('http://127.0.0.1:59943/health',
                        headers={'Authorization': 'Bearer '+token.read_text()})
            with urllib.request.urlopen(request, timeout=5) as response:
                health = json.load(response)
            self.assertTrue(health['ready'])
            self.assertFalse(health['retirement_unconfirmed'])
            self.assertEqual(health['source_sha256'], pins)
            self.assertEqual(health['selected_release_sha256'], self.env['RAYA_RETRIEVAL_RELEASE_SHA256'])
            self.assertEqual(health['active'], 0)
            def exchange(route, body=None, epoch=None):
                headers = {'Authorization': 'Bearer '+token.read_text(),
                           'X-Raya-Owner-Epoch': epoch or health['owner_epoch'],
                           'Content-Type': 'application/json', 'X-Raya-Request-Id': uuid.uuid4().hex}
                request = urllib.request.Request('http://127.0.0.1:59943/'+route,
                            data=None if body is None else json.dumps(body).encode(), headers=headers)
                try:
                    with urllib.request.urlopen(request, timeout=20) as response:
                        return response.status, json.load(response)
                except urllib.error.HTTPError as error:
                    with error:
                        return error.code, json.load(error)
            status, value = exchange('v2/drain', {}, 'f'*32)
            self.assertEqual(status, 409)
            self.assertEqual(value, {'error': {'code': 'owner_epoch_changed'}})
            for route in ('v2/drain', 'v2/resume'):
                status, value = exchange(route, {})
                lifecycle.append({'route': route, 'status': status, 'response': value})
                self.assertEqual(status, 200, value)
                self.assertEqual(value['owner_epoch'], health['owner_epoch'])
                self.assertEqual(value['selected_release_sha256'], health['selected_release_sha256'])
                self.assertEqual(value['draining'], route == 'v2/drain')
                for name in ('original_coordinator_retained', 'original_worker_retired',
                             'request_publications_confirmed', 'request_admissions_joined'):
                    self.assertTrue(value[name])
                self.assertIsNone(child.poll())
                status, observed = exchange('health')
                self.assertEqual(status, 200)
                self.assertEqual(observed['owner_epoch'], health['owner_epoch'])
                self.assertEqual(observed['ready'], route == 'v2/resume')
                self.assertEqual(observed['active'], 0)
                self.assertFalse(observed['retirement_unconfirmed'])
                if route == 'v2/drain':
                    # Unsupported model prevents inference even if intake closure regresses.
                    status, value = exchange('v2/embeddings', {'model': 'unselected-test-model', 'input': ['test']})
                    self.assertEqual(status, 503)
                    self.assertEqual(value, {'error': {'code': 'admission_closed'}})
        except BaseException as error:
            failure = error
        finally:
            try:
                child.stdin.write(b'STOP\n')
                child.stdin.flush()
            except (BrokenPipeError, OSError) as error:
                if failure is None:
                    failure = error
            child.stdin.close()
            child.wait()
            for reader in readers:
                reader.join()
            child.stdout.close()
            child.stderr.close()
            sampling.set()
            sampler.join()
        values = [json.loads(raw) for raw in lines]
        closed = [value for value in values if value.get('format') == 'raya.memory.disposable.supervisor.closed']
        report = {'passed': failure is None and not faults and child.returncode == 0 and len(closed) == 1 and closed[0]['passed'],
                  'models_admitted': False, 'installed_acceptance': False,
                  'protected_paths': len(paths), 'dependency_files': len(inventory['images']),
                  'health': health, 'lifecycle': lifecycle, 'phases': values, 'exit': child.returncode,
                  'observation_failure': type(failure).__name__ if failure is not None else None,
                  'memory_samples': samples, 'sample_interval_seconds': 0.1,
                  'minimum_sampled_available_bytes': min((item['available_bytes'] for item in samples), default=None),
                  'sampling_failures': [type(error).__name__ for error in faults],
                  'original_sampler_joined': not sampler.is_alive(),
                  'original_readers_joined': all(not reader.is_alive() for reader in readers),
                  'stderr': b''.join(errors).decode('utf-8', errors='replace')}
        output = Path('D:/Raya/Tools/Readiness-20261005')/('RETRIEVAL-REUSE-SUPERVISED-'+uuid.uuid4().hex+'.json')
        output.write_text(json.dumps(report, indent=2), encoding='utf-8')
        if failure is not None:
            raise failure
        if faults:
            raise BaseExceptionGroup('Original memory sampler failed', faults)
        self.assertTrue(samples)
        self.assertTrue(report['original_sampler_joined'])
        self.assertEqual(child.returncode, 0, report['stderr'])
        self.assertEqual(len(closed), 1)
        self.assertTrue(closed[0]['passed'], closed)
        self.assertTrue(closed[0]['control_joined'])
        self.assertTrue(report['original_readers_joined'])
        print('Evidence: '+str(output))


if __name__ == '__main__':
    unittest.main()
