"""Real source admission with fixture protection metadata; no native START/service."""
import hashlib
import json
from pathlib import Path
import unittest
import supervise_release_test as legacy

module = legacy.module


class Tests(unittest.TestCase):
    load = legacy.Release.load
    tearDown = legacy.Release.tearDown

    def setUp(self):
        legacy.Release.setUp(self)
        source = Path(self.plan['source'])
        keys = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')
        for name, sha in module.REUSE.items():
            path = source/name
            path.parent.mkdir(exist_ok=True)
            raw = (legacy.BASE/name).read_bytes()
            self.assertEqual(hashlib.sha256(raw).hexdigest(), sha)
            path.write_bytes(raw)
            info = path.lstat()
            self.plan['files'].append({'path': str(path), 'bytes': len(raw), 'sha256': sha,
                                      'identity': [getattr(info, key) for key in keys]})
        self.plan['kind'] = 'retrieval'
        self.plan['retrieval_protocol'] = 'raya.retrieval.request.settlement.v2'
        self.plan['source_sha256'] = dict(module.REUSE)
        private = {name: value for name, value in self.plan['env'].items() if not name.startswith('RAYA_')}
        self.plan['env'] = dict(private, RAYA_RETRIEVAL_TOKEN_FILE=str(self.root/'token'),
                                RAYA_RETRIEVAL_RECEIPT_ROOT=str(self.root/'receipts'),
                                RAYA_RETRIEVAL_RELEASE_SHA256='a'*64)

    def test_exact_sixteen_images_admitted_only_with_explicit_protocol(self):
        plan, images = self.load()
        self.assertEqual(len(images), 16)
        self.assertTrue(module.reusable(plan))
        self.assertEqual(module.entry(plan), Path(plan['source'])/'retrieval_reuse'/'entry.py')
        self.plan.pop('retrieval_protocol')
        with self.assertRaisesRegex(ValueError, 'Exact selected service release'):
            self.load()

    def test_stale_entry_and_missing_independent_release_refused(self):
        self.plan['source_sha256']['retrieval_reuse/entry.py'] = '0'*64
        with self.assertRaisesRegex(ValueError, 'Exact selected service release'):
            self.load()
        self.plan['source_sha256'] = dict(module.REUSE)
        self.plan['env'].pop('RAYA_RETRIEVAL_RELEASE_SHA256')
        with self.assertRaisesRegex(ValueError, 'Independent reusable release'):
            self.load()

    def test_nested_loader_selects_collision_free_original_sources(self):
        plan, images = self.load()
        source = Path(plan['source'])
        loader = module.Sources(source, images, True)
        self.assertEqual(loader.find_spec('owner').origin, str(source/'retrieval'/'owner.py'))
        self.assertEqual(loader.find_spec('server').origin, str(source/'retrieval_reuse'/'server.py'))
        self.assertEqual(loader.find_spec('entry').origin, str(source/'retrieval_reuse'/'entry.py'))
        self.assertIsNone(loader.find_spec('unselected'))
        self.assertIsNone(loader.find_spec('retrieval.server'))

    def test_protocol_cannot_be_unknown_or_attached_to_memory(self):
        for kind, protocol in [('retrieval', 'automatic'), ('memory', 'raya.retrieval.request.settlement.v2')]:
            with self.assertRaises(ValueError):
                module.reusable(dict(self.plan, kind=kind, retrieval_protocol=protocol))


if __name__ == '__main__':
    unittest.main()
