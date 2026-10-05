"""Original Journal provenance must settle before executor admission.

This boundary is after HTTP admission, before inference. It is not a cold
settlement warrant, a native retirement proof, or authority to select paths.
The server retains storage waits, cancellation and original Future ownership.
"""
from concurrent.futures import ThreadPoolExecutor, CancelledError
from historical import capture, image, sources, restore
from operations import Journal
from retirement import canonical, fingerprint, decode


def prepare(journal, key, kind, body, source):
    if not isinstance(journal, Journal):
        raise ValueError('Original Journal and local executor required.')
    sources(source)
    if fingerprint(source) != journal.release:
        raise ValueError('Original dispatch source selection differs.')
    with journal.namespace.lock:
        pending = journal.reserve(key, kind, body)
        selected = capture(journal, pending, source)
        value = selected.record()
        raw = canonical(value)
        name = key + '-' + fingerprint(value)[:32] + '.json'
        journal.namespace.publish(journal.folder, name, raw)
        actual, receipt = image(journal.namespace, journal.folder / name)
        if actual != raw or decode(actual) != value:
            raise ValueError('Original dispatch provenance differs.')
        # publish() has flushed/fsynced and rechecked ACL/generations; image()
        # holds exact bytes/identities again. No body can enter the pool earlier.
        return {'pending': pending, 'selection': selected,
                'provenance': dict(name=name, **receipt)}


def submit(journal, prepared, source, executor, task, cancel=None):
    if not isinstance(journal, Journal) or not isinstance(executor, ThreadPoolExecutor) or not callable(task):
        raise ValueError('Original Journal and local executor required.')
    with journal.namespace.lock:
        selected = capture(journal, prepared['pending'], source)
        value = selected.record()
        if value != prepared['selection'].record():
            raise ValueError('Original prepared selection differs.')
        name = prepared['pending']['request'] + '-' + fingerprint(value)[:32] + '.json'
        actual, receipt = image(journal.namespace, journal.folder / name)
        if dict(name=name, **receipt) != prepared['provenance'] or decode(actual) != value:
            raise ValueError('Original prepared provenance changed.')
        restore(journal.namespace, value)
        if cancel is not None and cancel.is_set():
            raise CancelledError('Cancelled before inference submission.')
        def enter():
            if cancel is not None and cancel.is_set():
                raise CancelledError('Cancelled before executor entry.')
            return task(prepared['pending'])
        return executor.submit(enter)


def dispatch(journal, key, kind, body, source, executor, task):
    prepared = prepare(journal, key, kind, body, source)
    future = submit(journal, prepared, source, executor, task)
    return dict(prepared, future=future)
