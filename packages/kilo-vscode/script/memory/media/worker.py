"""Finite explicitly selected media worker; its native owner supervises retirement."""
import ctypes
import json
import os
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from library import Library, inspect, read
from session import Session, encode, request, sha, verify
OWNED = False


def admission():
    if os.name != 'nt':
        raise ValueError('Windows native media resource observation required.')
    from ctypes import wintypes
    class Memory(ctypes.Structure):
        _fields_ = [('length', wintypes.DWORD), ('load', wintypes.DWORD), ('physical', ctypes.c_uint64), ('free', ctypes.c_uint64), ('commit', ctypes.c_uint64), ('available', ctypes.c_uint64), ('virtual', ctypes.c_uint64), ('unused', ctypes.c_uint64), ('extended', ctypes.c_uint64)]
    row = Memory()
    row.length = ctypes.sizeof(row)
    api = ctypes.WinDLL('kernel32', use_last_error=True).GlobalMemoryStatusEx
    api.argtypes = [ctypes.POINTER(Memory)]
    api.restype = wintypes.BOOL
    if not api(ctypes.byref(row)):
        raise ctypes.WinError(ctypes.get_last_error())
    if row.free > row.physical or row.available > row.commit:
        raise ValueError('Native media resource observation inconsistent.')
    if row.free < 10 * 1073741824 or row.available < 5 * 1073741824:
        raise ValueError('Cold media inference requires 10 GiB free RAM and 5 GiB free commit.')
    return dict(free=row.free, available=row.available)


def provenance(library, item, files):
    selected = [row for row in files if row['sha256'] == item['sha256'] and str(Path(row['path'])) == item['origin']]
    if len(selected) != 1 or selected[0]['kind'] != item['kind']:
        raise ValueError('Media snapshot origin is outside the exact selected source authority.')
    actual = library.item(item['id'])
    if actual != item:
        raise ValueError('Media snapshot metadata changed.')
    decoded = inspect(library.root / item['relative'])
    if decoded['sha256'] != item['sha256']:
        raise ValueError('Decoded snapshot revision changed.')
    return dict(id=item['id'], kind=item['kind'], origin=item['origin'], sourceSHA=item['sha256'], bytes=selected[0]['bytes'], snapshot=dict(path=str(library.root / item['relative']), sha256=item['sha256'], bytes=len(read(library.root / item['relative']))), decoded=decoded)


def checkpoint(value):
    path = Path(value['selection']['root']) / 'Requests' / value['epoch'] / (value['request'] + '.stop.json')
    if path.exists() or path.is_symlink():
        from supervisor import decode
        row = decode(read(path))
        pending = path.with_name(value['request'] + '.pending.json')
        expected = dict(format='raya.media.worker.stop.v1', request=value['request'], epoch=value['epoch'], release=value['release'], policySHA=value['policySHA'], pendingSHA=sha(read(pending)))
        if row != expected:
            raise ValueError('Media cancellation identity differs.')
        raise InterruptedError('Original media acceptance was cancelled.')


def execute(value, audit=True):
    value = request(value)
    if value['op'] in ('index', 'search'):
        if not OWNED:
            raise ValueError('Cold media inference requires the original contained START gate.')
        admission()
    session = Session(value) if audit else None
    try:
        checkpoint(value)
        files = value['selection']['files']
        library = Library(value['selection']['root'])
        op, args = value['op'], value['args']
        if op in ('inspect', 'import'):
            selected = next(row for row in files if row['sha256'] == args['id'])
            decoded = inspect(selected['path'])
            if decoded['sha256'] != selected['sha256'] or decoded['kind'] != selected['kind']:
                raise ValueError('Decoded media differs from original selection.')
            if op == 'inspect':
                result = dict(origin=selected['path'], sourceSHA=selected['sha256'], decoded=decoded, imported=False)
            else:
                existing = [item for item in library.inventory() if item['id'] == args['id']]
                if existing:
                    provenance(library, existing[0], files)
                result = dict(provenance(library, library.add(selected['path'], selected['title']), files), imported=True, indexed=False)
        elif op == 'forget':
            item = library.item(args['id'])
            result = dict(provenance(library, item, files), **library.forget(args['id']))
        else:
            if op == 'index':
                item = library.item(args['id'])
                binding = provenance(library, item, files)
            else:
                inventory = [provenance(library, item, files) for item in library.inventory() if any(entry['sha256'] == item['sha256'] and str(Path(entry['path'])) == item['origin'] for entry in files)]
                if len(inventory) != len(files):
                    raise ValueError('Every selected original must be imported before querying.')
            model = value['model']
            raw = read(model['path'])
            if len(raw) != model['bytes'] or sha(raw) != model['sha256']:
                raise ValueError('Exact authorized checkpoint manifest changed.')
            from encoder import Encoder
            checkpoint(value)
            admission()
            encoder = Encoder(model['path'])
            if read(model['path']) != raw:
                raise ValueError('Checkpoint manifest changed during loading.')
            if op == 'index':
                result = dict(binding, **encoder.index(library, args['id']))
                provenance(library, library.item(args['id']), files)
            else:
                rows = encoder.search(library, args['query'], segments=False, top=10) + encoder.search(library, args['query'], segments=True, top=10)
                rows.sort(key=lambda row: (-row['similarity'], row['id'], row.get('start', -1)))
                result = dict(querySHA=sha(args['query'].encode('utf-8')), inventory=inventory, candidates=[], authority=False)
                for row in rows:
                    item = library.item(row['id'])
                    if not any(entry['sha256'] == item['sha256'] and str(Path(entry['path'])) == item['origin'] for entry in files):
                        continue
                    binding = provenance(library, item, files)
                    start, end = row.get('start'), row.get('end')
                    if item['kind'] != 'image' and dict(start=start, end=end) not in inspect(library.root / item['relative'])['segments']:
                        raise ValueError('Media candidate requires its exact original decoded timestamp.')
                    if item['kind'] == 'image' and (start is not None or end is not None):
                        raise ValueError('Images cannot claim a recording timestamp.')
                    result['candidates'].append(dict(binding, start=start, end=end, verification='uncertain', verifier='unavailable', evidence='A supervised source evidence verifier is required.', authority=False))
                result['candidates'] = result['candidates'][:args['top']]
        checkpoint(value)
        verify(files)
        return session.finish('completed', result) if session else dict(format='raya.media.result.v1', request=value['request'], epoch=value['epoch'], release=value['release'], policySHA=value['policySHA'], op=value['op'], status='completed', result=result, authority=False)
    except Exception as err:
        # A terminal failure retains possible partial effects; it never authorizes replay.
        result = dict(error=type(err).__name__, message='Original media operation failed; preserve its audit for review.', uncertain=True, authority=False)
        return session.finish('failed', result) if session else dict(format='raya.media.result.v1', request=value['request'], epoch=value['epoch'], release=value['release'], policySHA=value['policySHA'], op=value['op'], status='failed', result=result, authority=False)


def main():
    global OWNED
    if len(sys.argv) == 9:
        if os.name != 'nt' or not sys.flags.isolated or not sys.flags.no_site or not sys.flags.dont_write_bytecode:
            raise ValueError('Isolated contained media worker required.')
        from supervisor import config, decode
        cfg = config(sys.argv[1], sys.argv[2])
        from ctypes import wintypes
        handle = wintypes.HANDLE(int(sys.argv[3]))
        api = ctypes.WinDLL('kernel32', use_last_error=True)
        api.ReadFile.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
        api.ReadFile.restype = wintypes.BOOL
        api.CloseHandle.argtypes = [wintypes.HANDLE]
        api.CloseHandle.restype = wintypes.BOOL
        frame = bytearray()
        while not frame.endswith(b'\n'):
            buffer = ctypes.create_string_buffer(1024)
            count = wintypes.DWORD()
            if not api.ReadFile(handle, buffer, len(buffer), ctypes.byref(count), None) or not count.value:
                raise ValueError('Original contained media START absent.')
            frame.extend(buffer.raw[:count.value])
            if len(frame) > 1024:
                raise ValueError('Contained media START bound exceeded.')
        if not api.CloseHandle(handle):
            raise ctypes.WinError(ctypes.get_last_error())
        expected = dict(format='raya.media.worker.start.v1', request=sys.argv[4], epoch=sys.argv[5], release=sys.argv[6], policySHA=sys.argv[7], selection=sys.argv[8])
        if decode(bytes(frame)) != expected:
            raise ValueError('Contained media START identity differs.')
        OWNED = True
        sys.path.append(cfg['dependencies'])
        raw = sys.stdin.buffer.read(131073)
        if not 0 < len(raw) <= 131072:
            raise ValueError('Media request exceeded its stdin bound.')
        value = decode(raw)
        if any(value.get(key) != expected[key] for key in ('request', 'epoch', 'release', 'policySHA')) or value.get('selection', {}).get('root') != cfg['root']:
            raise ValueError('Media payload differs from contained START.')
        row = execute(value, audit=False)
        result = encode(row)
        if len(result) > 131072:
            raise ValueError('Media result exceeded its stdout bound.')
        sys.stdout.buffer.write(result + b'\n')
        sys.stdout.buffer.flush()
        return
    raise ValueError('Fixed contained media worker launch required.')


if __name__ == '__main__':
    try:
        main()
    except Exception as err:
        sys.stderr.write('Media worker refused: ' + type(err).__name__ + '\n')
        sys.exit(1)
