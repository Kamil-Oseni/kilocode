"""Real protected Windows namespaces; no services, models, tokens or personal roots."""
import ctypes
from ctypes import wintypes as w
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
SOURCE = HERE/'service'/'namespace.py'
SPEC = importlib.util.spec_from_file_location('namespace', SOURCE)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Tests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='raya-namespace-test-')).resolve()
        self.addCleanup(self.cleanup)
        script = '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'
        # Original child and both streams are naturally joined; no force/timeout.
        scriptpath = self.root/'protect.ps1'
        scriptpath.write_text(script, encoding='utf-8')
        child = subprocess.Popen([r'C:\Users\kamil\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe', '-NoProfile', '-NonInteractive', '-File', str(scriptpath), str(self.root)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=0x08000000)
        out, err = child.communicate()
        self.assertEqual(child.returncode, 0, err.decode('utf-8'))
        scriptpath.unlink()
        self.sid = out.decode('utf-8').strip()
        library = ctypes.WinDLL('advapi32', use_last_error=True)
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        pointer = w.LPVOID
        library.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [w.LPCWSTR, w.DWORD, ctypes.POINTER(pointer), ctypes.POINTER(w.DWORD)]
        library.GetSecurityDescriptorDacl.argtypes = [pointer, ctypes.POINTER(w.BOOL), ctypes.POINTER(pointer), ctypes.POINTER(w.BOOL)]
        library.SetNamedSecurityInfoW.argtypes = [w.LPWSTR, ctypes.c_int, w.DWORD, pointer, pointer, pointer, pointer]
        library.SetNamedSecurityInfoW.restype = w.DWORD
        kernel.LocalFree.argtypes = [pointer]
        kernel.LocalFree.restype = pointer
        descriptor, dacl = pointer(), pointer()
        present, default = w.BOOL(), w.BOOL()
        sddl = 'D:P'+''.join('(A;OICI;FA;;;'+sid+')' for sid in (self.sid, 'S-1-5-18', 'S-1-5-32-544'))
        self.assertTrue(library.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor), None))
        try:
            self.assertTrue(library.GetSecurityDescriptorDacl(descriptor, ctypes.byref(present), ctypes.byref(dacl), ctypes.byref(default)))
            self.assertTrue(present.value)
            self.assertEqual(library.SetNamedSecurityInfoW(str(self.root), 1, 4|0x80000000, None, None, dacl, None), 0)
        finally:
            self.assertFalse(kernel.LocalFree(descriptor))
        for name in ('Runs', 'Requests'):
            (self.root/name).mkdir()
        generations = {name: MODULE.generation(self.root if name == 'root' else self.root/name) for name in ('root','Runs','Requests')}
        self.namespace = MODULE.Namespace(str(self.root), self.sid, generations)
        self.folder = self.namespace.folder('Requests', 'a'*32)

    def cleanup(self):
        root = self.root.resolve()
        parent = Path(tempfile.gettempdir()).resolve()
        assert root.parent == parent and root.name.startswith('raya-namespace-test-') and root.is_absolute()
        shutil.rmtree(root)

    def test_pending_terminal_and_original_forms(self):
        for name in ('b'*32+'-pending.json', 'b'*32+'-terminal.json', 'c'*32+'-'+'d'*32+'.json', '000001.json', '1000000.json'):
            raw = json.dumps({'status':name}).encode('utf-8')
            self.namespace.publish(self.folder, name, raw)
            self.assertEqual((self.folder/name).read_bytes(), raw)
            MODULE.acl(self.folder/name, self.sid)
            with self.assertRaises(FileExistsError):
                self.namespace.publish(self.folder, name, raw)

    def test_actual_journal_reserve_complete(self):
        self.folder.rmdir()  # Only the original empty test epoch, never a live namespace.
        sys.modules['namespace'] = MODULE
        sys.path.insert(0, str(HERE/'service'))
        from operations import Journal
        journal = Journal(str(self.root), self.sid,
                          {name: MODULE.generation(self.root if name == 'root' else self.root/name) for name in ('root', 'Runs', 'Requests')},
                          'e'*32, 'f'*64)
        pending = journal.reserve('1'*32, 'sync', {'force_rebuild': False})
        terminal = journal.complete(pending, {}, 'failed', [])
        self.assertEqual(json.loads((journal.folder/('1'*32+'-pending.json')).read_bytes()), pending)
        self.assertEqual(json.loads((journal.folder/('1'*32+'-terminal.json')).read_bytes()), terminal)
        self.assertEqual(terminal['operation_outcome'], 'failed')
        self.assertEqual(pending['status'], 'pending')
        with self.assertRaises(FileExistsError):
            journal.reserve('1'*32, 'sync', {'force_rebuild': False})

    def test_malformed_traversal_and_unselected(self):
        for name in ('pending.json', 'b'*31+'-pending.json', 'b'*32+'-arbitrary.json', 'b'*32+'-PENDING.json', '../escape.json', 'a/b.json', 'a\\b.json'):
            with self.assertRaises(ValueError):
                self.namespace.publish(self.folder, name, b'{}')
        with self.assertRaises(ValueError):
            self.namespace.publish(self.root/'unselected', '000001.json', b'{}')
        self.assertEqual(list(self.folder.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
