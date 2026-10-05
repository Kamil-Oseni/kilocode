"""Production-order and original error-cleanup tests; no NumPy/service/model import."""
import ast
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SOURCE = Path(__file__).with_name('supervise.py')


def failed(action):
    spec = importlib.util.spec_from_file_location('supervise', SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # Genuine prepare failure before native import; exercise original keeper/finally.
    if action == 'classfailure':
        # Genuine Python import failure using disposable file-backed dependencies,
        # not native NumPy/Transformers, tokenizer construction or model assets.
        with tempfile.TemporaryDirectory(prefix='raya-preload-import-', dir=SOURCE.parent) as name:
            deps = Path(name)
            (deps / 'numpy.py').write_text('# Lightweight dependency fixture\n', encoding='utf-8')
            (deps / 'transformers.py').write_text("raise ImportError('Synthetic AutoTokenizer class import refused')\n", encoding='utf-8')
            module.serve({'env': {}, 'dependencies': str(deps), 'source': str(SOURCE.parent), 'kind': 'memory', 'files': []}, {})
        return
    module.serve({'env': {}, 'source': str(SOURCE.parent), 'kind': 'memory', 'files': []}, {})


class Preload(unittest.TestCase):
    def case(self, data, action='failure', expected='KeyError'):
        child = subprocess.Popen([sys.executable, '-I', '-S', '-B', str(Path(__file__).resolve()), action],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 creationflags=subprocess.CREATE_NO_WINDOW)
        stdout, stderr = child.communicate(data)
        self.assertEqual(child.returncode, 1)
        self.assertLess(len(stdout), 4096)
        self.assertLess(len(stderr), 16384)
        rows = [json.loads(line) for line in stdout.splitlines()]
        closed = rows[-1]
        self.assertEqual(closed['format'], 'raya.memory.disposable.supervisor.closed')
        self.assertFalse(closed['passed'])
        self.assertTrue(closed['control_joined'])
        self.assertEqual(closed['errors'][0], expected)
        return closed

    def test_prepare_failure_retains_stop_join(self):
        closed = self.case(b'STOP\n')
        self.assertFalse(closed['control_eof'])
        self.assertEqual(closed['errors'], ['KeyError'])

    def test_prepare_failure_retains_eof_join(self):
        closed = self.case(b'')
        self.assertTrue(closed['control_eof'])
        self.assertEqual(closed['errors'], ['KeyError'])

    def test_primary_and_bad_control_errors_retained(self):
        closed = self.case(b'BAD\n')
        self.assertEqual(closed['errors'], ['KeyError', 'ValueError'])

    def test_transformers_import_failure_retains_original_join(self):
        closed = self.case(b'STOP\n', action='classfailure', expected='ImportError')
        self.assertEqual(closed['errors'], ['ImportError'])
        self.assertFalse(closed['control_eof'])

    def test_actual_production_order(self):
        tree = ast.parse(SOURCE.read_bytes())
        functions = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}
        prepare = functions['prepare']
        env = next(node.lineno for node in ast.walk(prepare) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'update')
        deps = next(node.lineno for node in ast.walk(prepare) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'append')
        native = next(node.lineno for node in ast.walk(prepare) if isinstance(node, ast.Import) and node.names[0].name == 'numpy')
        self.assertLess(env, deps)
        self.assertLess(deps, native)
        classes = [node for node in ast.walk(prepare) if isinstance(node, ast.ImportFrom)]
        self.assertEqual([(node.module, [alias.name for alias in node.names]) for node in classes], [('transformers', ['AutoTokenizer'])])
        self.assertLess(native, classes[0].lineno)
        serve = functions['serve']
        preparecall = next(node.lineno for node in ast.walk(serve) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'prepare')
        starts = [node.lineno for node in ast.walk(serve) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name) and node.func.value.id == 'thread' and node.func.attr == 'start']
        self.assertTrue(starts)
        self.assertTrue(all(preparecall < line for line in starts))
        imports = [node for node in ast.walk(prepare) if isinstance(node, ast.Import)]
        self.assertEqual([item.name for node in imports for item in node.names], ['numpy'])


if __name__ == '__main__':
    if len(sys.argv) == 2 and sys.argv[1] in ('failure', 'classfailure'):
        failed(sys.argv[1])
    else:
        unittest.main()
