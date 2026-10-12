"""Exact entry boundaries and a line-preserving active-recall projection.

The original Markdown and source journals remain immutable history. Projection
never rewrites notes; readers must retain the original file hash and line spans.
"""
import hashlib
import json
import re
from notes import identity


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')


def fingerprint(name, start, end, raw, kind, key=None):
    return digest(canonical([name, start, end, digest(raw), kind, key]))


def marker(line, prefix):
    if not line.startswith(prefix):
        return None
    if not line.endswith(' -->'):
        raise ValueError('Incomplete Memory entry marker.')
    value = json.loads(line[len(prefix):-4])
    if not isinstance(value, dict):
        raise ValueError('Exact Memory entry marker required.')
    return value


def records(name, text):
    """Return complete entries; incomplete managed/capture boundaries refuse."""
    if not isinstance(text, str) or len(text.encode('utf-8')) > 256000:
        raise ValueError('Bounded UTF-8 note required.')
    lines = text.splitlines(keepends=True)
    rows = []
    covered = set()
    changes = []
    index = 0
    fence = None
    while index < len(lines):
        line = lines[index].rstrip('\r\n')
        fenced = re.match(r'^ {0,3}(`{3,}|~{3,})', line)
        if fenced:
            value = fenced[1]
            if fence is None:
                fence = value
            elif value[0] == fence[0] and len(value) >= len(fence):
                fence = None
            covered.add(index)
            index += 1
            continue
        if fence is not None:
            covered.add(index)
            index += 1
            continue
        entry = marker(line, '<!-- raya.memory.entry.v1 ')
        if entry is not None:
            if set(entry) != {'id', 'source_sha256'} or not re.fullmatch('[a-f0-9]{64}', str(entry['source_sha256'])):
                raise ValueError('Invalid managed entry source marker.')
            identity(entry['id'])
            end = index + 1
            while end < len(lines) and lines[end].rstrip('\r\n') != '<!-- raya.memory.entry.end.v1 ' + entry['id'] + ' -->':
                if lines[end].lstrip().startswith('<!-- raya.memory.'):
                    raise ValueError('Nested or incomplete managed entry refused.')
                end += 1
            if end == len(lines):
                raise ValueError('Managed entry has no complete end boundary.')
            raw = ''.join(lines[index:end + 1]).encode('utf-8')
            excerpt = ''.join(lines[index + 1:end]).strip()
            if not excerpt or len(excerpt.encode('utf-8')) > 8192:
                raise ValueError('Managed entry exceeds its passage bound.')
            rows.append({'entry': entry['id'], 'start': index, 'end': end + 1, 'raw': raw,
                         'excerpt': excerpt, 'kind': 'managed', 'source_sha256': entry['source_sha256']})
            covered.update(range(index, end + 1))
            index = end + 1
            continue
        change = marker(line, '<!-- raya.memory.supersession.v1 ')
        if change is not None:
            if (set(change) != {'id', 'target', 'entry_sha256', 'action'} or
                    change['action'] not in {'correct', 'forget'} or
                    not re.fullmatch('[a-f0-9]{64}', str(change['entry_sha256'])) or
                    not isinstance(change['target'], str) or
                    not re.fullmatch(r'(?:[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})', change['target'])):
                raise ValueError('Invalid entry-specific supersession marker.')
            identity(change['id'])
            changes.append(dict(change, line=index))
            covered.add(index)
            index += 1
            continue
        capture = re.fullmatch(r'## Raya capture ([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})', line)
        if capture:
            key = capture[1]
            identity(key)
            stop = index + 1
            while stop < len(lines) and not re.match(r'^#{1,2}(?:[ \t]+|$)|^<!-- raya.memory.', lines[stop]):
                stop += 1
            if 'Interpretation of a recorded conversation; not independently verified.' not in ''.join(lines[index:stop]):
                raise ValueError('Captured entry qualification is missing.')
            starts = [number for number in range(index + 1, stop) if re.fullmatch(r'### [a-z0-9][a-z0-9_-]{0,79}\r?\n?', lines[number])]
            if not starts:
                raise ValueError('Captured entries have no complete keyed boundaries.')
            for offset, start in enumerate(starts):
                end = starts[offset + 1] if offset + 1 < len(starts) else stop
                # Store.apply's source footer belongs to the journal, not the fact.
                end = next((number for number in range(start, end) if lines[number].startswith('Recorded update:')), end)
                while end > start and not lines[end - 1].strip():
                    end -= 1
                namekey = lines[start].strip()[4:]
                raw = ''.join(lines[start:end]).encode('utf-8')
                rows.append({'entry': digest(canonical(['capture', key, namekey])), 'start': start, 'end': end,
                             'raw': raw, 'excerpt': ''.join(lines[start:end]).strip(), 'kind': 'capture',
                             'capture': key, 'key': namekey})
            covered.update(range(index, stop))
            index = stop
            continue
        if line.startswith('<!-- raya.memory.'):
            raise ValueError('Unknown or detached Memory entry marker.')
        index += 1
    index = 0
    while index < len(lines):
        line = lines[index]
        if index in covered or not line.strip() or re.match(r'^\s*(?:#{1,6}(?:[ \t]+|$)|Recorded update:)', line):
            index += 1
            continue
        start = index
        while index < len(lines) and index not in covered and lines[index].strip() and not re.match(r'^#{1,6}(?:[ \t]+|$)', lines[index]):
            index += 1
        raw = ''.join(lines[start:index]).encode('utf-8')
        if len(raw) <= 4096:
            rows.append({'entry': fingerprint(name, start, index, raw, 'curated'), 'start': start, 'end': index,
                         'raw': raw, 'excerpt': raw.decode('utf-8').strip(), 'kind': 'curated'})
    ids = {row['entry']: row for row in rows}
    if len(ids) != len(rows):
        raise ValueError('Duplicate Memory entry identity.')
    retired = set()
    for change in changes:
        row = ids.get(change['target'])
        if row is None or sum(item['entry'] == change['target'] for item in rows) != 1 or digest(row['raw']) != change['entry_sha256'] or row['entry'] in retired:
            raise ValueError('Supersession target differs from its exact original entry.')
        retired.add(row['entry'])
    return lines, rows, retired, changes


def project(name, text):
    """Blank retired entries and bookkeeping without shifting original spans."""
    lines, rows, retired, changes = records(name, text)
    for row in rows:
        if row['entry'] in retired:
            for number in range(row['start'], row['end']):
                lines[number] = '\n' if lines[number].endswith('\n') else ''
    markers = {row['line'] for row in changes}
    for row in rows:
        if row['kind'] == 'managed':
            markers.update((row['start'], row['end'] - 1))
    for number in markers:
        lines[number] = '\n' if lines[number].endswith('\n') else ''
    return ''.join(lines)


def render(key, source, fact):
    identity(key)
    if not isinstance(fact, str) or not fact.strip() or len(fact.encode('utf-8')) > 4096 or '<!-- raya.memory.' in fact:
        raise ValueError('Bounded complete original user fact required.')
    if not isinstance(source, str) or not re.fullmatch('[a-f0-9]{64}', source):
        raise ValueError('Original user source hash required.')
    return ('\n\n<!-- raya.memory.entry.v1 ' + canonical({'id': key, 'source_sha256': source}).decode('utf-8') +
            ' -->\nRecorded user statement; not independently verified.\n\n' + fact +
            '\n<!-- raya.memory.entry.end.v1 ' + key + ' -->\n')


def supersede(key, row, action):
    identity(key)
    if action not in {'correct', 'forget'}:
        raise ValueError('Entry correction or forgetting required.')
    return '\n\n<!-- raya.memory.supersession.v1 ' + canonical({'id': key, 'target': row['entry'],
                'entry_sha256': digest(row['raw']), 'action': action}).decode('utf-8') + ' -->\n'
