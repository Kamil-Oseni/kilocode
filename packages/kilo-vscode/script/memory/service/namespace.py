"""Existing selected protected receipt namespace; no ACL repair or root creation."""
import ctypes
from ctypes import wintypes as w
import json
import os
from pathlib import Path
import re
import stat
import threading


class Information(ctypes.Structure):
    _fields_ = [('count', w.DWORD), ('used', w.DWORD), ('free', w.DWORD)]


class Header(ctypes.Structure):
    _fields_ = [('type', w.BYTE), ('flags', w.BYTE), ('size', w.WORD)]


def generation(path):
    row = path.lstat()
    if not stat.S_ISDIR(row.st_mode) or getattr(row, 'st_file_attributes', 0) & 0x400:
        raise ValueError('receipt_directory_identity')
    return [row.st_dev, row.st_ino, row.st_birthtime_ns]


def acl(path, principal, protected=False):
    library = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    pointer = w.LPVOID
    library.GetNamedSecurityInfoW.restype = w.DWORD
    library.GetSecurityDescriptorControl.argtypes = [pointer, ctypes.POINTER(w.WORD), ctypes.POINTER(w.DWORD)]
    library.GetSecurityDescriptorControl.restype = w.BOOL
    library.GetAclInformation.argtypes = [pointer, pointer, w.DWORD, ctypes.c_int]
    library.GetAclInformation.restype = w.BOOL
    library.GetAce.argtypes = [pointer, w.DWORD, ctypes.POINTER(pointer)]
    library.GetAce.restype = w.BOOL
    library.IsValidSid.argtypes = [pointer]
    library.IsValidSid.restype = w.BOOL
    library.ConvertSidToStringSidW.argtypes = [pointer, ctypes.POINTER(w.LPWSTR)]
    library.ConvertSidToStringSidW.restype = w.BOOL
    kernel.LocalFree.argtypes = [pointer]
    kernel.LocalFree.restype = pointer
    owner, dacl, descriptor = pointer(), pointer(), pointer()
    # GetNamedSecurityInfo has five pointer outputs: owner/group/DACL/SACL/descriptor.
    library.GetNamedSecurityInfoW.argtypes = [w.LPWSTR, ctypes.c_int, w.DWORD]+[ctypes.POINTER(pointer)]*5
    code = library.GetNamedSecurityInfoW(str(path), 1, 1|4, ctypes.byref(owner), None,
                                         ctypes.byref(dacl), None, ctypes.byref(descriptor))
    if code:
        raise OSError(code, 'GetNamedSecurityInfoW')
    errors = []
    try:
        if not owner or not dacl or not descriptor:
            raise ValueError('receipt_null_descriptor')
        def sid(address):
            if not library.IsValidSid(address):
                raise ValueError('receipt_sid')
            text = w.LPWSTR()
            if not library.ConvertSidToStringSidW(address, ctypes.byref(text)):
                raise OSError(ctypes.get_last_error(), 'ConvertSidToStringSidW')
            value = text.value
            if kernel.LocalFree(ctypes.cast(text, pointer)):
                raise OSError(ctypes.get_last_error(), 'LocalFree_sid')
            return value
        if sid(owner) != principal:
            raise ValueError('receipt_selected_owner')
        control, revision = w.WORD(), w.DWORD()
        if not library.GetSecurityDescriptorControl(descriptor, ctypes.byref(control), ctypes.byref(revision)):
            raise OSError(ctypes.get_last_error(), 'GetSecurityDescriptorControl')
        if not control.value & 4 or (protected and not control.value & 0x1000):
            raise ValueError('receipt_protected_dacl')
        information = Information()
        if not library.GetAclInformation(dacl, ctypes.byref(information), ctypes.sizeof(information), 2):
            raise OSError(ctypes.get_last_error(), 'GetAclInformation')
        if information.count != 3:
            raise ValueError('receipt_acl_count')
        trustees = set()
        for index in range(information.count):
            address = pointer()
            if not library.GetAce(dacl, index, ctypes.byref(address)):
                raise OSError(ctypes.get_last_error(), 'GetAce')
            header = Header.from_address(address.value)
            if header.type != 0 or header.size < 16 or header.flags & ~0x13 or header.flags & 8:
                raise ValueError('receipt_allow_ace')
            if path.is_dir() and header.flags & 3 != 3:
                raise ValueError('receipt_directory_inheritance')
            mask = w.DWORD.from_address(address.value+4).value
            if mask != 0x1f01ff:
                raise ValueError('receipt_full_control')
            trustee = sid(pointer(address.value+8))
            if trustee in trustees:
                raise ValueError('receipt_duplicate_trustee')
            trustees.add(trustee)
        if trustees != {principal, 'S-1-5-18', 'S-1-5-32-544'}:
            raise ValueError('receipt_trustees')
    except BaseException as error:
        errors.append(error)
    finally:
        if descriptor and kernel.LocalFree(descriptor):
            errors.append(OSError(ctypes.get_last_error(), 'LocalFree_descriptor'))
    if errors:
        raise BaseExceptionGroup('Receipt namespace ACL observation failed.', errors)


class Namespace:
    def __init__(self, root, principal, expected):
        self.root = Path(root)
        if not self.root.is_absolute() or not re.fullmatch('S-1-[0-9]+(?:-[0-9]+)+', principal):
            raise ValueError('selected_receipt_namespace')
        if set(expected) != {'root', 'Runs', 'Requests'} or any(not isinstance(value, list) or len(value) != 3 or any(type(item) is not int for item in value) for value in expected.values()):
            raise ValueError('selected_receipt_generations')
        self.principal = principal
        self.lock = threading.RLock()
        self.generations = {self.root: expected['root'], self.root/'Runs': expected['Runs'],
                            self.root/'Requests': expected['Requests']}
        self.check()

    def check(self):
        for parent in self.root.parents:
            generation(parent)
        for path, expected in tuple(self.generations.items()):
            if generation(path) != expected:
                raise ValueError('receipt_namespace_changed')
            acl(path, self.principal, protected=path == self.root)

    def folder(self, kind, epoch, request=None):
        if kind not in ('Runs', 'Requests') or not re.fullmatch('[a-f0-9]{32}', epoch) or (request is not None and not re.fullmatch('[a-f0-9]{32}', request)):
            raise ValueError('receipt_fixed_folder')
        with self.lock:
            self.check()
            path = self.root/kind
            for name in (epoch,) if request is None else (epoch, request):
                path /= name
                if path not in self.generations:
                    path.mkdir(exist_ok=False)
                    self.generations[path] = generation(path)
                self.check()
            return path

    def publish(self, folder, name, raw):
        if not re.fullmatch(r'(?:[a-f0-9-]+|[a-f0-9]{32}-(?:pending|terminal))\.json', name) or not isinstance(raw, bytes) or len(raw) > 65536:
            raise ValueError('receipt_fixed_publication')
        with self.lock:
            self.check()
            if folder not in self.generations:
                raise ValueError('receipt_unselected_folder')
            path = folder/name
            primary = None
            try:
                with path.open('xb') as file:
                    file.write(raw)
                    file.flush()
                    os.fsync(file.fileno())
                    original = os.fstat(file.fileno())
                row = path.lstat()
                if not stat.S_ISREG(row.st_mode) or row.st_nlink != 1 or row.st_size != len(raw) or getattr(row, 'st_file_attributes', 0) & 0x400:
                    raise ValueError('receipt_published_identity')
                with path.open('rb') as file:
                    opened = os.fstat(file.fileno())
                    actual = file.read(65537)
                    final = os.fstat(file.fileno())
                after = path.lstat()
                names = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_nlink')
                identity = tuple(getattr(original, name) for name in names)
                if actual != raw or any(tuple(getattr(value, name) for name in names) != identity for value in (row, opened, final, after)) or row.st_ctime_ns != after.st_ctime_ns or opened.st_ctime_ns != final.st_ctime_ns:
                    raise ValueError('receipt_publication_bytes_or_identity_changed')
                acl(path, self.principal)
            except BaseException as error:
                primary = error
            try:
                self.check()
            except BaseException as error:
                if primary is not None:
                    raise BaseExceptionGroup('Receipt publication and closing guard failed.', [primary, error])
                raise
            if primary is not None:
                raise primary
