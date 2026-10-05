"""Real portable source layout checks; no worker, service or model is started."""
import hashlib
import importlib.util
import os
from pathlib import Path
import shutil
import tempfile
import unittest

SOURCE=Path(__file__).parent/'retrieval'

def module(file):
 spec=importlib.util.spec_from_file_location('portable_'+file.stem,file)
 value=importlib.util.module_from_spec(spec)
 spec.loader.exec_module(value)
 return value

class Portable(unittest.TestCase):
 def test_two_real_capsules(self):
  with tempfile.TemporaryDirectory() as tmp:
   for name in ('raya-memory-managed-one','raya-memory-managed-two'):
    root=Path(tmp)/name; source=root/'source'/'retrieval';source.mkdir(parents=True)
    for leaf in ('home','tmp','hf','dependencies'):(root/leaf).mkdir()
    for file in SOURCE.iterdir():shutil.copyfile(file,source/file.name)
    boot=module(source/'bootstrap.py');owner=module(source/'owner.py')
    self.assertEqual(boot.DEPENDENCIES,root/'dependencies');self.assertEqual(owner.BASE,root/'python'/'python.exe')
    self.assertEqual(owner.ENV,boot.ENV)
    self.assertEqual(owner.PINS['bootstrap'],hashlib.sha256((source/'bootstrap.py').read_bytes()).hexdigest())
    previous=dict(os.environ)
    try:
     os.environ.update(boot.ENV);boot.private()
     os.environ['TEMP']=str(Path(tmp)/'foreign')
     with self.assertRaisesRegex(ValueError,'private_environment'):boot.private()
    finally:
     os.environ.clear();os.environ.update(previous)
 def test_foreign_layout(self):
  boot=module(SOURCE/'bootstrap.py');owner=module(SOURCE/'owner.py')
  with self.assertRaisesRegex(ValueError,'private_source_layout'):boot.private()
  with self.assertRaisesRegex(ValueError,'private_source_layout'):owner.Owner.spawn(None)
 def test_catalogs(self):
  import ast,re
  parent=Path(__file__).parent
  tree=ast.parse((parent/'supervise.py').read_bytes())
  release=ast.literal_eval(next(n.value for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='RELEASES' for t in n.targets)))
  actual={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in SOURCE.iterdir()}
  self.assertEqual(release['retrieval'],actual)
  catalog=parent.parent.parent/'src/second-brain/managed/catalog.ts'
  self.assertEqual(dict(re.findall(r'"([a-z_]+\.py)": "([a-f0-9]{64})"',catalog.read_text())),actual)
  self.assertIn(hashlib.sha256((parent/'supervise.py').read_bytes()).hexdigest(),catalog.read_text())

if __name__=='__main__':unittest.main()
