"""Observe retained native handles before accepting a reusable completion.

The caller retains creation-time handles and authenticated source baselines. This
observer neither discovers/adopts a PID nor creates a retirement receipt.
"""
import ctypes
from ctypes import wintypes as w
import os
from owner import checked, identity, selected
from validation import fingerprint, result


def observe(library, process, job, birth, images):
    if not process or not job or not isinstance(birth, dict) or set(birth) != {'birth_filetime', 'image'}:
        raise ValueError('live_original_identity')
    if not isinstance(images, dict) or 'interpreter' not in images:
        raise ValueError('live_selected_images')
    state = library.WaitForSingleObject(process, 0)
    if state == 0xffffffff:
        raise OSError(ctypes.get_last_error(), 'WaitForSingleObject_live')
    if state != 258:
        raise ValueError('live_process_not_running')
    current = identity(library, process)
    if current != birth or os.path.normcase(current['image']) != os.path.normcase(str(images['interpreter']['path'])):
        raise ValueError('live_process_identity_changed')
    member = w.BOOL()
    checked(library.IsProcessInJob(process, job, ctypes.byref(member)), 'IsProcessInJob_live')
    if not member.value:
        raise ValueError('live_original_job_membership')
    for image in images.values():
        if (not isinstance(image, dict) or set(image) != {'path', 'sha256', 'observed'} or
                selected(image['path'], image['sha256']) != image['observed']):
            raise ValueError('live_selected_image_changed')
    # Re-observe after source verification; hashing must not mask an intervening exit.
    if library.WaitForSingleObject(process, 0) != 258 or identity(library, process) != birth:
        raise ValueError('live_completion_observation_changed')
    checked(library.IsProcessInJob(process, job, ctypes.byref(member)), 'IsProcessInJob_completion')
    if not member.value:
        raise ValueError('live_completion_membership_changed')
    return {'original_process_running': True, 'original_job_membership_observed': True,
            'selected_images_unchanged': True, 'worker': current}


def accept(lease, body, value, revision, library, process, job, birth, images):
    current = lease.current
    if (current is None or not isinstance(value, dict) or
            set(value) != set(current) | {'format', 'result'} or
            value['format'] != 'raya.retrieval.lease.completion' or
            type(value['version']) is not int or type(value['sequence']) is not int or
            any(value[key] != expected for key, expected in current.items()) or
            fingerprint(body) != current['request_sha256']):
        raise ValueError('live_completion_identity')
    output = result(value['result'], lease.kind, body, revision)
    evidence = observe(library, process, job, birth, images)
    receipt = {**current, 'format': 'raya.retrieval.lease.observation', **evidence}
    lease.current = None
    return output, receipt
