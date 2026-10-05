"""Opt-in genuine model-free health/ordinary-close test; Root admission required.

No synthetic service replaces the selected entrypoints. This is not run by the
source-preparation lane. Supply RAYA_MEMORY_SUPERVISOR_TEST_PLAN and SHA only
after disposable namespace, dependency and environment review.
"""
import hashlib
import http.client
import json
import os
from pathlib import Path
import subprocess
import stat
import sys
import threading
import time
import unittest


def diagnostics(plan):
    root = Path(plan['diagnostic_root'])
    info = root.lstat()
    if not root.is_absolute() or root.resolve() != root or not root.name.startswith('raya-memory-disposable-diagnostics-'):
        raise ValueError('Fresh protected diagnostics root required')
    if not stat.S_ISDIR(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
        raise ValueError('Ordinary diagnostics root required')
    if [info.st_dev, info.st_ino, info.st_birthtime_ns] != plan['diagnostic_generation']:
        raise ValueError('Diagnostics generation differs')
    proof = plan['diagnostic_protection']
    raw = Path(proof['path']).read_bytes()
    if len(raw) > 1048576 or hashlib.sha256(raw).hexdigest() != proof['sha256']:
        raise ValueError('Diagnostics protection evidence differs')
    value = json.loads(raw)
    if value.get('passed') is not True or value.get('protected') is not True or value.get('identities') != 3 or Path(value['root']) != root:
        raise ValueError('Protected diagnostics evidence required')
    return root


def persist(root, mode, record, rows):
    if mode not in ('stop', 'eof') or set(rows) != {'stdout', 'stderr'}:
        raise ValueError('Exact diagnostic case required')
    if any(len(raw) > 65536 for raw in rows.values()):
        raise ValueError('Diagnostic output bound exceeded')
    folder = root / ('case-' + mode)
    folder.mkdir()
    sidecars = {}
    for name, raw in rows.items():
        path = folder / name
        with path.open('xb') as held:
            held.write(raw)
            held.flush()
            os.fsync(held.fileno())
        sidecars[name] = {'path': str(path), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
    raw = json.dumps(dict(record, sidecars=sidecars), separators=(',', ':'), allow_nan=False).encode('utf-8')
    if len(raw) > 65536:
        raise ValueError('Diagnostic record bound exceeded')
    path = folder / 'terminal.json'
    with path.open('xb') as held:
        held.write(raw)
        held.flush()
        os.fsync(held.fileno())
    return {'path': str(path), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


class Supervisor(unittest.TestCase):
    def test_original_health_stop_and_eof(self):
        name = os.environ.get('RAYA_MEMORY_SUPERVISOR_TEST_PLAN')
        expected = os.environ.get('RAYA_MEMORY_SUPERVISOR_TEST_SHA')
        if not name or not expected:
            self.skipTest('No Root-reviewed disposable execution plan supplied')
        raw = Path(name).read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), expected)
        plan = json.loads(raw)
        self.assertTrue(plan['execution_admitted'])
        # A distinct protected empty namespace/plan is required for each case:
        # no replay/adoption of prior selected service epoch or receipts.
        for item in plan['cases']:
            with self.subTest(mode=item['mode']):
                self.check(item, plan)

    def check(self, item, plan):
        self.assertIn(item['mode'], ('stop', 'eof'))
        source = Path(__file__).with_name('supervise.py')
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), plan['supervisor_sha256'])
        self.assertEqual(hashlib.sha256(Path(sys.executable).read_bytes()).hexdigest(), plan['python_sha256'])
        service = json.loads(Path(item['plan']).read_bytes())
        self.assertEqual(hashlib.sha256(Path(item['plan']).read_bytes()).hexdigest(), item['sha256'])
        # Parent bootstrap env is explicit; service installs its separate reviewed
        # private environment before importing any selected service module.
        root = diagnostics(plan)
        begun = time.monotonic()
        attempts = 0
        requests = 0
        phases = []
        rows = {'stdout': bytearray(), 'stderr': bytearray()}
        eof = {'stdout': False, 'stderr': False}
        errors = []
        release = threading.Event()
        original = {'child': None}

        def drain(name):
            overflow = False
            release.wait()
            if original['child'] is None:
                return
            pipe = getattr(original['child'], name)
            try:
                while True:
                    data = pipe.read(4096)
                    if not data:
                        eof[name] = True
                        break
                    space = 65536 - len(rows[name])
                    rows[name].extend(data[:max(0, space)])
                    if len(data) > space and not overflow:
                        overflow = True
                        errors.append(RuntimeError('Original output bound exceeded'))
            except BaseException as error:
                errors.append(error)
            finally:
                try:
                    pipe.close()
                except BaseException as error:
                    errors.append(error)

        threads = [threading.Thread(target=drain, args=(name,), daemon=False)
                   for name in rows]
        # Both original pipes are continuously retained/drained before readiness.
        started = []
        spawned = None
        try:
            for thread in threads:
                thread.start()
                started.append(thread)
            child = subprocess.Popen([sys.executable, '-I', '-S', '-B', '-u', str(source), item['plan'], item['sha256']],
                                     env=plan['parent_env'], cwd=plan['cwd'], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=0x08000000)
            original['child'] = child
        except BaseException as error:
            spawned = error
        finally:
            release.set()
            if original['child'] is None:
                for thread in started:
                    thread.join()
        if spawned is not None:
            record = {'mode': item['mode'], 'pid': None, 'code': None, 'eof': eof,
                      'elapsed': time.monotonic() - begun, 'phase': 'spawn',
                      'attempts': 0, 'requestsSent': 0, 'errors': [type(spawned).__name__], 'passed': False}
            try:
                saved = persist(root, item['mode'], record, rows)
                print(json.dumps({'diagnostic': saved}), flush=True)
            except BaseException as error:
                raise BaseExceptionGroup('Spawn and diagnostic failures retained', [spawned, error])
            raise spawned
        failure = None
        phases.append({'phase': 'health', 'elapsed': time.monotonic() - begun})
        try:
            until = time.monotonic() + 30
            while True:
                attempts += 1
                conn = http.client.HTTPConnection('127.0.0.1', service['port'], timeout=2)
                try:
                    # Only the newly provisioned disposable token is read. No
                    # existing credential/SecretStorage path is accepted by plan.
                    field = 'RAYA_MEMORY_TOKEN_FILE' if service['kind'] == 'memory' else 'RAYA_RETRIEVAL_TOKEN_FILE'
                    token = Path(service['env'][field]).read_text(encoding='utf-8').strip()
                    conn.request('GET', '/health', headers={'Authorization': 'Bearer ' + token})
                    requests += 1
                    response = conn.getresponse()
                    data = response.read(65537)
                    self.assertLessEqual(len(data), 65536)
                    self.assertEqual(response.status, 200)
                    value = json.loads(data)
                    self.assertTrue(value['ready'])
                    self.assertEqual(value['active'], 0)
                    self.assertEqual(value['source_sha256'], service['source_sha256'])
                    break
                except (ConnectionRefusedError, TimeoutError):
                    if child.poll() is not None or time.monotonic() >= until:
                        raise
                    time.sleep(0.05)
                finally:
                    conn.close()
        except BaseException as error:
            failure = error
        finally:
            phases.append({'phase': 'ordinary-close', 'elapsed': time.monotonic() - begun})
            # Failure never authorizes force/retry. Request the same ordinary
            # STOP/EOF and retain this test process until original exit+EOF join.
            try:
                if item['mode'] == 'stop':
                    child.stdin.write(b'STOP\n')
                    child.stdin.flush()
            except BaseException as error:
                errors.append(error)
            try:
                child.stdin.close()
            except BaseException as error:
                errors.append(error)
            code = None
            try:
                code = child.wait()
            except BaseException as error:
                errors.append(error)
            finally:
                for thread in threads:
                    thread.join()
        if failure is not None:
            errors.insert(0, failure)
        terminal = None
        try:
            self.assertEqual(code, 0)
            self.assertTrue(all(eof.values()))
            terminal = json.loads(bytes(rows['stdout']).splitlines()[-1])
            self.assertTrue(terminal['passed'])
            self.assertTrue(terminal['control_joined'])
            self.assertEqual(terminal['control_eof'], item['mode'] == 'eof')
            self.assertEqual(terminal['errors'], [])
        except BaseException as error:
            errors.append(error)
        phases.append({'phase': 'joined', 'elapsed': time.monotonic() - begun})
        record = {'mode': item['mode'], 'pid': child.pid, 'code': code, 'eof': eof,
                  'elapsed': time.monotonic() - begun, 'phases': phases, 'attempts': attempts,
                  'requestsSent': requests, 'errors': [type(error).__name__ for error in errors],
                  'healthError': type(failure).__name__ if failure is not None else None,
                  'terminal': terminal, 'passed': not errors}
        try:
            saved = persist(root, item['mode'], record, rows)
            print(json.dumps({'diagnostic': saved}), flush=True)
        except BaseException as error:
            errors.append(error)
        if errors:
            raise BaseExceptionGroup('Original fixture failures retained', errors)


if __name__ == '__main__':
    unittest.main()
