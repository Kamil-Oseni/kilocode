"""Real manifest admission and result validation; no model imports or device actions."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

BASE = Path(__file__).resolve().parent/'retrieval'


def module(name):
    spec = importlib.util.spec_from_file_location(name, BASE/(name+'.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


bootstrap = module('bootstrap')
validation = module('validation')
REVISION = '914f7f89142e33e77833254d9c9b90c3cef7303b'


class Gemma(unittest.TestCase):
    def manifest(self):
        return bootstrap.decode(bootstrap.image(bootstrap.CATALOG/'google--embeddinggemma-2.json', bootstrap.MANIFESTS['google--embeddinggemma-2.json']))

    def response(self, model='embeddinggemma-2', dimensions=768):
        return {'object': 'list', 'model': model, 'revision': REVISION,
                'dimensions': dimensions, 'normalized': True,
                'data': [{'object': 'embedding', 'index': 0, 'embedding': [1.0]+[0.0]*(dimensions-1)}],
                'timing': {'seconds': 0.1}}

    def test_real_pinned_checkpoint_admission(self):
        manifest = self.manifest()
        self.assertIs(bootstrap.checkpoint(manifest), manifest)

    def test_manifest_and_content_refusals(self):
        original = self.manifest()
        for key, value in [('source', 'other'), ('revision', 'other'), ('path', 'C:/other'), ('status', 'partial')]:
            manifest = copy.deepcopy(original)
            manifest[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                bootstrap.checkpoint(manifest)
        for name in ('../escape', '/escape', 'C:/escape', 'a\\b', 'a//b'):
            manifest = copy.deepcopy(original)
            manifest['files'][0]['name'] = name
            with self.subTest(name=name), self.assertRaises(ValueError):
                bootstrap.checkpoint(manifest)
        manifest = copy.deepcopy(original)
        manifest['files'][0]['sha256'] = '0'*64
        with self.assertRaisesRegex(ValueError, 'gemma_checkpoint_changed'):
            bootstrap.checkpoint(manifest)

    def test_selected_model_dimensions(self):
        body = {'model': 'embeddinggemma-2', 'input': ['fixture']}
        response = self.response()
        self.assertIs(validation.result(response, 'embeddings', body, REVISION), response)
        qwen = self.response('qwen3-embedding-0.6b', 1024)
        self.assertIs(validation.result(qwen, 'embeddings', {'input': ['fixture']}, REVISION), qwen)
        for value in (qwen, self.response(dimensions=1024), self.response('unknown')):
            with self.assertRaises(ValueError):
                validation.result(value, 'embeddings', body, REVISION)
        with self.assertRaises(ValueError):
            validation.result(response, 'embeddings', {'input': ['fixture']}, REVISION)

    def test_revision_and_vector_refusals(self):
        body = {'model': 'embeddinggemma-2', 'input': ['fixture']}
        with self.assertRaises(ValueError):
            validation.result(self.response(), 'embeddings', body, 'other')
        for vector in ([1.0]*768, [float('nan')]+[0.0]*767, [1.0]+[0.0]*766):
            response = self.response()
            response['data'][0]['embedding'] = vector
            with self.assertRaises(ValueError):
                validation.result(response, 'embeddings', body, REVISION)


if __name__ == '__main__':
    unittest.main()
