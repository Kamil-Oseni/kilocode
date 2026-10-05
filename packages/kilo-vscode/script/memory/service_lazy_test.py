"""Focused original index-function checks; no selected service import or inference."""
import ast
from contextvars import ContextVar
from pathlib import Path
import threading
import time
import unittest


SOURCE = Path(__file__).parent / 'service' / 'index.py'


def scope():
    tree = ast.parse(SOURCE.read_text(encoding='utf-8'))
    names = {'Cancelled', 'remaining', 'tokenizer', 'tokens'}
    nodes = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in names]
    value = {'time': time, 'threading': threading, 'CANCEL': ContextVar('test_cancel', default=None),
             'DEADLINE': ContextVar('test_deadline', default=None), 'TOKENIZER': None,
             'GATE': threading.Lock()}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(SOURCE), 'exec'), value)
    return value


class Lazy(unittest.TestCase):
    def test_eager_imports(self):
        tree = ast.parse(SOURCE.read_text(encoding='utf-8'))
        names = [node.module for node in tree.body if isinstance(node, ast.ImportFrom)]
        names += [item.name for node in tree.body if isinstance(node, ast.Import) for item in node.names]
        self.assertNotIn('numpy', names)
        self.assertNotIn('transformers', names)
        for node in tree.body:
            if isinstance(node, ast.Assign):
                self.assertFalse(any(isinstance(item, ast.Attribute) and item.attr == 'from_pretrained' for item in ast.walk(node)))

    def test_cancel_before_import(self):
        value = scope()
        cancel = threading.Event()
        cancel.set()
        token = value['CANCEL'].set(cancel)
        try:
            with self.assertRaises(value['Cancelled']):
                value['tokenizer']()
            self.assertIsNone(value['TOKENIZER'])
            self.assertFalse(value['GATE'].locked())
        finally:
            value['CANCEL'].reset(token)

    def test_held_lock_deadline(self):
        value = scope()
        lock = value['GATE']
        lock.acquire()
        token = value['DEADLINE'].set(time.monotonic() + 0.02)
        try:
            with self.assertRaises(TimeoutError):
                value['tokenizer']()
            self.assertTrue(lock.locked())
            self.assertIsNone(value['TOKENIZER'])
        finally:
            value['DEADLINE'].reset(token)
            lock.release()


if __name__ == '__main__':
    unittest.main()
