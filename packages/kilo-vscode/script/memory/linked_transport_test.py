"""Production request decoding, no FastAPI, service credentials or inference."""
import ast
from pathlib import Path
import unittest

SOURCE = Path(__file__).parent / 'service/server.py'
TREE = ast.parse(SOURCE.read_bytes())
CODE = ast.Module(body=[node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == 'search'], type_ignores=[])
exec(compile(ast.fix_missing_locations(CODE), str(SOURCE), 'exec'), globals())


class Tests(unittest.TestCase):
    def test_normal_search_body_is_unchanged(self):
        self.assertEqual(search({'query': 'Eden'}), {'query': 'Eden', 'top': 5})
        self.assertEqual(search({'query': 'Eden', 'top': 10}), {'query': 'Eden', 'top': 10})

    def test_explicit_context_body_keeps_budget_in_fingerprint_input(self):
        for budget in (1, 3000, 12000):
            self.assertEqual(search({'query': 'Eden', 'context_budget': budget}),
                             {'query': 'Eden', 'top': 5, 'context_budget': budget})

    def test_invalid_context_and_unknown_fields_refused_before_admission(self):
        for budget in (None, False, True, 0, 12001, 1.5, '3000', float('nan')):
            with self.assertRaises(ValueError):
                search({'query': 'Eden', 'context_budget': budget})
        for value in ({'query': 'Eden', 'capture_enabled': True}, {'query': 'Eden', 'root': 'foreign'},
                      {'query': ' '}, {'query': 'Eden', 'top': True}):
            with self.assertRaises(ValueError):
                search(value)


if __name__ == '__main__':
    unittest.main()
