"""Root-admitted actual local dependencies only; never imports the service/server."""
import ast
from contextvars import ContextVar
import os
from pathlib import Path
import sqlite3
import threading
import time
import unittest


SOURCE = Path(__file__).parent / 'service' / 'index.py'


def scope():
    path = Path(os.environ['RAYA_MEMORY_TOKENIZER_PATH'])
    if not path.is_absolute() or not path.is_dir():
        raise ValueError('Explicit admitted local tokenizer directory required.')
    if os.environ.get('HF_HUB_OFFLINE') != '1':
        raise ValueError('Offline dependency admission required.')
    tree = ast.parse(SOURCE.read_text(encoding='utf-8'))
    names = {'Cancelled', 'remaining', 'tokenizer', 'tokens', 'decode'}
    nodes = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in names]
    value = {'time': time, 'threading': threading, 'sqlite3': sqlite3,
             'CANCEL': ContextVar('dependency_cancel', default=None),
             'DEADLINE': ContextVar('dependency_deadline', default=None),
             'TOKENIZER': None, 'GATE': threading.Lock(), 'MODEL': {'path': str(path)}}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(SOURCE), 'exec'), value)
    return value


class Dependencies(unittest.TestCase):
    def test_actual_local_cache(self):
        value = scope()
        first = value['tokenizer']()
        self.assertIs(first, value['tokenizer']())
        text = 'A synthetic local tokenizer check.'
        self.assertEqual(value['tokens'](text), len(first.encode(text, add_special_tokens=False)))
        self.assertGreater(value['tokens'](text), 0)
        self.assertFalse(value['GATE'].locked())
        cancel = threading.Event()
        cancel.set()
        token = value['CANCEL'].set(cancel)
        try:
            with self.assertRaises(value['Cancelled']):
                value['tokenizer']()
            self.assertIs(value['TOKENIZER'], first)
        finally:
            value['CANCEL'].reset(token)

    def test_actual_numpy_decode(self):
        import numpy as np
        value = scope()
        vector = np.zeros(1024, dtype=np.float32)
        vector[0] = 1
        self.assertTrue(np.array_equal(value['decode'](vector.tobytes()), vector))
        for raw in (b'', b'x' * 4095, np.zeros(1024, dtype=np.float32).tobytes()):
            with self.assertRaises(sqlite3.DatabaseError):
                value['decode'](raw)
        for number in (float('nan'), float('inf'), 2):
            vector[0] = number
            with self.assertRaises(sqlite3.DatabaseError):
                value['decode'](vector.tobytes())


if __name__ == '__main__':
    if os.environ.get('RAYA_MEMORY_DEPENDENCY_TEST_ADMITTED') != '1':
        raise SystemExit('Root-reviewed isolated dependency execution admission required.')
    unittest.main()
