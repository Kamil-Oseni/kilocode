"""Candidate host-owned policy leases. No HTTP approval or automatic admission."""
import hashlib
import json
import os
import stat
import uuid
from contextlib import contextmanager
from pathlib import Path
from policy import Policy, Refused


def failures(err):
    if isinstance(err, BaseExceptionGroup):
        return [leaf for item in err.exceptions for leaf in failures(item)]
    return [err]


class Retirement(Refused):
    """A downstream request cannot yet be proven retired."""


class Namespace(Refused):
    """A captured root/System directory generation no longer matches."""


def directory(path):
    try:
        row = path.lstat()
        if not stat.S_ISDIR(row.st_mode) or getattr(row, 'st_file_attributes', 0) & 0x400 or not row.st_ino:
            raise Namespace('Memory directories must have ordinary, identifiable generations.')
        return (row.st_dev, row.st_ino, getattr(row, 'st_birthtime_ns', None))
    except OSError as err:
        raise Namespace('Memory directory generation is unavailable.') from err


@contextmanager
def closing(check):
    """Run a closing invariant even on failure, preserving both exceptions."""
    primary = None
    try:
        yield
    except BaseException as err:
        primary = err
        raise
    finally:
        try:
            check()
        except BaseException as err:
            if primary is not None:
                raise BaseExceptionGroup('Operation and closing invariant failed.', [primary, err]) from None
            raise


def image(path):
    try:
        before = path.lstat()
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 1048576:
            raise Refused('Admission policy must be a bounded ordinary file.')
        with path.open('rb') as file:
            held = os.fstat(file.fileno())
            raw = file.read(1048577)
            final = os.fstat(file.fileno())
        after = path.lstat()
        # Windows path stat reports creation time while handle stat can report
        # rename/change time. Compare each ctime within its own representation.
        fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_nlink')
        expected = tuple(getattr(before, key) for key in fields)
        if (any(tuple(getattr(row, key) for key in fields) != expected for row in (held, final, after))
                or before.st_ctime_ns != after.st_ctime_ns or held.st_ctime_ns != final.st_ctime_ns
                or len(raw) != before.st_size):
            raise Refused('Admission policy changed while reading.')
        return raw
    except OSError as err:
        raise Refused('Admission policy is unavailable.') from err


def identity(row):
    if not stat.S_ISREG(row.st_mode) or row.st_nlink != 1 or not row.st_ino or getattr(row, 'st_file_attributes', 0) & 0x400:
        raise Namespace('A retained file leaf must be ordinary and single-linked.')
    return (row.st_dev, row.st_ino)


def entry(path):
    return identity(path.lstat()) if os.path.lexists(path) else None


@contextmanager
def leaf(path, expected, check):
    """Retain the original descriptor through the operation and closing checks."""
    check()
    file = path.open('x+b' if expected is None else 'r+b')
    original = None
    def named():
        check()
        if original is None or entry(path) != original:
            raise Namespace('Original file leaf was replaced; preserve the foreign entry.')
    def held():
        named()
        if identity(os.fstat(file.fileno())) != original:
            raise Namespace('Original file descriptor identity differs.')
    with closing(named):
        with file:
            original = identity(os.fstat(file.fileno()))
            if expected is not None and original != expected:
                raise Namespace('Selected file generation changed before opening.')
            held()
            with closing(held):
                yield file, held, original


def publish(path, raw, check):
    """One guarded staged publication; preserve failed publication and cleanup."""
    stage = path.parent / ('publish-' + uuid.uuid4().hex + '.json')
    original = None
    def identity(row):
        if not stat.S_ISREG(row.st_mode) or row.st_nlink != 1 or getattr(row, 'st_file_attributes', 0) & 0x400:
            raise Namespace('Publication leaf must remain ordinary and single-linked.')
        return (row.st_dev, row.st_ino)
    def selected():
        check()
        if original is None or identity(stage.lstat()) != original:
            raise Namespace('Original staged publication identity changed; preserve the foreign entry.')
    def cleanup():
        if os.path.lexists(stage):
            selected()
            stage.unlink()
    with closing(cleanup):
        check()
        with stage.open('xb') as file:
            original = identity(os.fstat(file.fileno()))
            file.write(raw)
            file.flush()
            os.fsync(file.fileno())
            if identity(os.fstat(file.fileno())) != original:
                raise Namespace('Original staging descriptor identity changed.')
        selected()
        os.replace(stage, path)
        check()
        if identity(path.lstat()) != original or image(path) != raw:
            raise Namespace('Published target differs from the original staged file.')


def serialize(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


class Lease:
    def __init__(self, store, raw):
        self.store = store
        self.raw = raw
        self.sha = hashlib.sha256(raw).hexdigest()
        try:
            self.value = json.loads(raw.decode('utf-8-sig'))
            self.policy = Policy(self.value)
            self.policy.bind(store.root)
        except (ValueError, UnicodeDecodeError) as err:
            raise Refused('General-source admission is disabled or invalid.') from err

    def check(self):
        self.store.check()
        if image(self.store.file) != self.raw:
            raise Refused('General-source policy changed; retry after review.')
        self.policy.bind(self.store.root)
        self.store.check()


class Store:
    def __init__(self, root, *, existing=False, generation=None):
        if type(existing) is not bool or (generation is not None and not existing):
            raise ValueError('Captured generations require existing-only construction.')
        root = Path(root)
        captured = directory(root)
        if root.is_symlink() or root.is_junction() or not root.is_dir():
            raise Refused('Admission root must be an ordinary directory.')
        self.root = root.resolve()
        system = self.root / 'System'
        if system.is_symlink() or system.is_junction():
            raise Refused('Admission directory cannot be a link.')
        if not existing:
            system.mkdir(exist_ok=True)
        self.generation = {self.root: captured, system: directory(system)}
        if generation is not None and self.generation != generation:
            raise Namespace('Existing directory generations changed before construction.')
        self.file = system / 'general-admission.json'
        self.lock = system / 'general-admission.lock'
        self.retirement = system / 'retrieval-retirement.json'
        self.namespace = system / 'general-namespace.json'
        self.expected = {'format': 'raya-memory-namespace-v1', 'root': str(self.root),
                         'generation': {'root': list(captured), 'system': list(self.generation[system])}}
        self.check()

    def check(self):
        for path, expected in self.generation.items():
            if directory(path) != expected:
                raise Namespace('Memory root/System directory generation changed; trusted re-admission is required.')
        if os.path.lexists(self.namespace):
            try:
                if json.loads(image(self.namespace)) != self.expected:
                    raise Namespace('Durable Memory directory generation does not match; trusted re-admission is required.')
            except (OSError, ValueError) as err:
                raise Namespace('Durable Memory namespace receipt is unavailable or mismatched.') from err
        elif os.path.lexists(self.file):
            raise Namespace('Existing admission has no directory-generation receipt; deliberate migration is required.')

    def pending(self):
        self.check()
        if not os.path.lexists(self.retirement):
            return False
        try:
            from retirement import decode, ledger
            value = ledger(decode(image(self.retirement)))
            return value['status'] not in ('retired', 'settled')
        except (OSError, ValueError):
            return True

    def record(self, value):
        self.check()
        if os.path.lexists(self.retirement):
            image(self.retirement)
        publish(self.retirement, (json.dumps(value, sort_keys=True) + '\n').encode(), self.check)

    def begin(self, key, port, epoch, release, parent, digest, protocol='raya.retrieval.retirement.v1'):
        # Caller holds the admission lease; persist before any POST submission.
        if self.pending():
            raise Retirement('Prior retrieval retirement requires trusted local inspection.')
        from retirement import ledger
        if protocol not in ('raya.retrieval.retirement.v1', 'raya.retrieval.request.settlement.v2'):
            raise Retirement('Explicit downstream protocol selection differs.')
        format = 'raya-retrieval-settlement-v3' if protocol.endswith('.v2') else 'raya-retrieval-retirement-v2'
        value = ledger({'format': format, 'request': key,
                        'port': port, 'status': 'pending', 'owner_epoch': epoch,
                        'selected_release_sha256': release, 'parent_request': parent,
                        'request_sha256': digest})
        self.record(value)
        return value

    def finish(self, value, proof):
        from retirement import decode, ledger, certificate
        if ledger(decode(image(self.retirement))) != value:
            raise Retirement('Retrieval retirement record changed.')
        reusable = value['format'] == 'raya-retrieval-settlement-v3'
        certificate(proof, value['request'], value['owner_epoch'], value['selected_release_sha256'], value['request_sha256'],
                    'raya.retrieval.request.settlement.v2' if reusable else 'raya.retrieval.retirement.v1')
        self.record(ledger(dict(value, status='settled' if reusable else 'retired', certificate=proof)))

    @contextmanager
    def locked(self):
        import msvcrt
        self.check()
        if os.path.lexists(self.lock):
            row = self.lock.lstat()
            if not stat.S_ISREG(row.st_mode) or row.st_nlink != 1:
                raise Refused('Admission lock must be an ordinary file.')
        with self.lock.open('a+b') as file:
            row = os.fstat(file.fileno())
            current = self.lock.lstat()
            if not stat.S_ISREG(row.st_mode) or row.st_nlink != 1 or (row.st_dev, row.st_ino) != (current.st_dev, current.st_ino):
                raise Refused('Admission lock changed.')
            if row.st_size == 0:
                file.write(b'0')
                file.flush()
            file.seek(0)
            try:
                msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as err:
                raise Refused('Admission operation is busy; change not accepted.') from err
            def unlock():
                file.seek(0)
                msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)
            with closing(unlock):
                self.check()
                with closing(self.check):
                    yield file

    @contextmanager
    def lease(self):
        with self.locked():
            if self.pending():
                raise Retirement('Prior retrieval retirement is unconfirmed; admission is closed.')
            lease = Lease(self, image(self.file))
            lease.check()
            with closing(lease.check):
                yield lease

    def replace(self, value, expected, gate=None):
        """Trusted host boundary only; caller must establish actual user review.

        This helper is intentionally NOT exposed by the search HTTP service.
        JSON review fields alone do not establish approval provenance.
        A busy update is refused, never acknowledged as an accepted pause.
        """
        policy = Policy(value)
        if policy.root != self.root:
            raise Refused('Admission policy belongs to another root.')
        raw = serialize(value)
        if len(raw) > 1048576:
            raise Refused('Admission policy is too large.')
        with self.locked():
            prior = image(self.file) if os.path.lexists(self.file) else None
            actual = hashlib.sha256(prior).hexdigest() if prior is not None else None
            if expected != actual:
                raise Refused('Admission policy revision conflict.')
            if prior is not None and value['revision'] <= json.loads(prior.decode('utf-8-sig'))['revision']:
                raise Refused('Admission revision must increase.')
            def check():
                self.check()
                if gate is not None:
                    gate()
                self.check()
            check()
            if not os.path.lexists(self.namespace):
                # Only first trusted policy publication establishes durable identity.
                # Existing policy without a receipt was already refused by check().
                with self.namespace.open('xb') as file:
                    file.write((json.dumps(self.expected, sort_keys=True) + '\n').encode())
                    file.flush()
                    os.fsync(file.fileno())
                self.check()
            publish(self.file, raw, check)
        return hashlib.sha256(raw).hexdigest()
