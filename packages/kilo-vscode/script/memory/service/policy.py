"""Candidate admission guard; approval provenance belongs to an authenticated host."""
import hashlib
import re
from pathlib import Path, PurePosixPath

class Refused(ValueError):
    pass

class Policy:
    def __init__(self, value):
        if not isinstance(value, dict) or set(value) != {'format', 'root', 'enabled', 'revision', 'files'}:
            raise ValueError('Invalid general-source policy.')
        if value['format'] != 'raya-general-sources-v1' or type(value['enabled']) is not bool:
            raise ValueError('Invalid policy identity.')
        if type(value['revision']) is not int or value['revision'] < 1 or not isinstance(value['root'], str):
            raise ValueError('Invalid policy revision/root.')
        root = Path(value['root'])
        if not root.is_absolute() or root.is_symlink() or root.is_junction():
            raise ValueError('Policy root must be an absolute ordinary directory.')
        self.root = root.resolve()
        self.enabled = value['enabled']
        rows = value['files']
        if not isinstance(rows, list) or len(rows) > 128:
            raise ValueError('Invalid source list.')
        self.files = {}
        for row in rows:
            if not isinstance(row, dict) or set(row) != {'relative', 'sha256', 'classification', 'review'}:
                raise ValueError('Invalid source record.')
            name = row['relative']
            if not isinstance(name, str) or not name or name != PurePosixPath(name).as_posix():
                raise ValueError('Invalid source path.')
            parts = name.split('/')
            if any(not part or part in {'.', '..'} or re.search(r'[\\<>:"|?*\x00-\x1f]', part) or part.endswith((' ', '.')) for part in parts) or not name.lower().endswith('.md'):
                raise ValueError('Invalid source path.')
            key = name.casefold()
            if key in self.files or not isinstance(row['sha256'], str) or not re.fullmatch('[a-f0-9]{64}', row['sha256']):
                raise ValueError('Invalid/duplicate source revision.')
            if row['classification'] != 'general' or row['review'] not in {'proposed', 'approved'}:
                raise ValueError('Source classification/review required.')
            if self.restricted(name):
                raise ValueError('Restricted source cannot be admitted as general.')
            self.files[key] = dict(row)

    @staticmethod
    def restricted(name):
        parts = name.casefold().split('/')
        reserved = {'system', 'archive', '.git', 'health', 'medical', 'private', 'sensitive'}
        return any(part in reserved or PurePosixPath(part).stem in reserved for part in parts)

    def bind(self, root):
        path = Path(root)
        if path.is_symlink() or path.is_junction() or path.resolve() != self.root:
            raise Refused('Policy belongs to a different root.')
        if not self.enabled:
            raise Refused('General-source admission is disabled.')

    def admit(self, name):
        row = self.files.get(name.casefold())
        return bool(row and row['review'] == 'approved' and not self.restricted(name))

    def verify(self, name, raw):
        if not self.admit(name) or hashlib.sha256(raw).hexdigest() != self.files[name.casefold()]['sha256']:
            raise Refused('Reviewed source revision changed; review again.')
