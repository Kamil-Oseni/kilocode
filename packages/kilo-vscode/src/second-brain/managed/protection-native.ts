import path from "node:path"
import { check } from "../control/frames"
import { command } from "../control/command"
import { directory, environment, image } from "../control/identity"
import type { Descriptor } from "./descriptor"

const script = `import ctypes,json,os,pathlib,stat,sys
from ctypes import wintypes as w
def require(value):
 if not value: raise ValueError('strict_root_protection')
def run():
 root=pathlib.Path(sys.argv[1]);before=root.lstat()
 require(root.is_absolute() and root.resolve()==root and stat.S_ISDIR(before.st_mode) and not getattr(before,'st_file_attributes',0)&0x400)
 kernel=ctypes.WinDLL('kernel32',use_last_error=True);native=ctypes.WinDLL('advapi32',use_last_error=True)
 pointer=w.LPVOID
 kernel.GetCurrentProcess.argtypes=[];kernel.GetCurrentProcess.restype=w.HANDLE
 kernel.CloseHandle.argtypes=[w.HANDLE];kernel.CloseHandle.restype=w.BOOL
 kernel.LocalFree.argtypes=[pointer];kernel.LocalFree.restype=pointer
 native.OpenProcessToken.argtypes=[w.HANDLE,w.DWORD,ctypes.POINTER(w.HANDLE)];native.OpenProcessToken.restype=w.BOOL
 native.GetTokenInformation.argtypes=[w.HANDLE,ctypes.c_int,pointer,w.DWORD,ctypes.POINTER(w.DWORD)];native.GetTokenInformation.restype=w.BOOL
 native.IsValidSid.argtypes=[pointer];native.IsValidSid.restype=w.BOOL
 native.GetLengthSid.argtypes=[pointer];native.GetLengthSid.restype=w.DWORD
 native.ConvertSidToStringSidW.argtypes=[pointer,ctypes.POINTER(w.LPWSTR)];native.ConvertSidToStringSidW.restype=w.BOOL
 native.GetNamedSecurityInfoW.argtypes=[w.LPWSTR,ctypes.c_int,w.DWORD]+[ctypes.POINTER(pointer)]*5;native.GetNamedSecurityInfoW.restype=w.DWORD
 native.GetSecurityDescriptorControl.argtypes=[pointer,ctypes.POINTER(w.WORD),ctypes.POINTER(w.DWORD)];native.GetSecurityDescriptorControl.restype=w.BOOL
 native.GetAclInformation.argtypes=[pointer,pointer,w.DWORD,ctypes.c_int];native.GetAclInformation.restype=w.BOOL
 native.IsValidAcl.argtypes=[pointer];native.IsValidAcl.restype=w.BOOL
 native.GetAce.argtypes=[pointer,w.DWORD,ctypes.POINTER(pointer)];native.GetAce.restype=w.BOOL
 def sid(address):
  require(address and native.IsValidSid(address));text=w.LPWSTR()
  require(native.ConvertSidToStringSidW(address,ctypes.byref(text)))
  try: return text.value
  finally: require(not kernel.LocalFree(ctypes.cast(text,pointer)))
 token=w.HANDLE();require(native.OpenProcessToken(kernel.GetCurrentProcess(),8,ctypes.byref(token)))
 try:
  size=w.DWORD();require(not native.GetTokenInformation(token,1,None,0,ctypes.byref(size)) and ctypes.get_last_error()==122 and 0<size.value<=65536)
  buffer=ctypes.create_string_buffer(size.value);require(native.GetTokenInformation(token,1,buffer,size.value,ctypes.byref(size)))
  principal=sid(ctypes.cast(buffer,ctypes.POINTER(pointer))[0])
 finally: require(kernel.CloseHandle(token))
 class Information(ctypes.Structure): _fields_=[('count',w.DWORD),('used',w.DWORD),('free',w.DWORD)]
 class Header(ctypes.Structure): _fields_=[('type',w.BYTE),('flags',w.BYTE),('size',w.WORD)]
 def acl():
  owner,dacl,descriptor=pointer(),pointer(),pointer()
  require(native.GetNamedSecurityInfoW(str(root),1,5,ctypes.byref(owner),None,ctypes.byref(dacl),None,ctypes.byref(descriptor))==0)
  try:
   require(owner and dacl and descriptor and native.IsValidAcl(dacl) and sid(owner)==principal)
   control,revision=w.WORD(),w.DWORD();require(native.GetSecurityDescriptorControl(descriptor,ctypes.byref(control),ctypes.byref(revision)))
   require(control.value&4 and control.value&0x1000)
   info=Information();require(native.GetAclInformation(dacl,ctypes.byref(info),ctypes.sizeof(info),2) and info.count==3)
   trustees=set()
   for index in range(info.count):
    address=pointer();require(native.GetAce(dacl,index,ctypes.byref(address)))
    header=Header.from_address(address.value);require(header.type==0 and header.flags==3 and header.size>=16)
    require(w.DWORD.from_address(address.value+4).value==0x1f01ff)
    trustee=pointer(address.value+8);require(native.IsValidSid(trustee) and header.size==8+native.GetLengthSid(trustee))
    value=sid(trustee);require(value not in trustees);trustees.add(value)
   require(trustees=={principal,'S-1-5-18','S-1-5-32-544'})
  finally: require(not kernel.LocalFree(descriptor))
 acl();acl()
 after=root.lstat()
 def identity(info): return (info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns,info.st_nlink,info.st_mode,getattr(info,'st_file_attributes',0))
 require(root.resolve()==root and identity(before)==identity(after))
 return {'sid':principal,'protected':True}
try: print(json.dumps(run(),separators=(',',':')))
except Exception as error: print(json.dumps({'refused':type(error).__name__},separators=(',',':')))`

/** Fresh native token and exact explicit three-rule ACL; no authority is cached. */
export async function protection(root: string, python: Descriptor["python"]) {
  check(
    process.platform === "win32" && path.isAbsolute(root) && root.length <= 4096 && !/[\0\r\n]/.test(root),
    "Explicit Windows managed root required",
  )
  check(
    path.isAbsolute(python.path) && python.path.length <= 4096 && !/[\0\r\n]/.test(python.path),
    "Explicit selected protection interpreter required",
  )
  const args = ["-I", "-S", "-B", "-c", script, root]
  // Upper bound includes worst-case doubled quote/backslash escaping and delimiters.
  check(
    [python.path, ...args].reduce((size, value) => size + value.length * 2 + 3, 0) < 32767,
    "Protection invocation exceeds Windows bound",
  )
  await directory(path.dirname(python.path))
  const before = await image(python.path, 536870912)
  check(
    before.raw.length === python.bytes && before.digest === python.sha256,
    "Selected protection interpreter differs",
  )
  const output = await command(python.path, args, { windowsHide: true, env: environment() }, 15000, 1024)
  const after = await image(python.path, 536870912)
  check(
    after.raw.length === python.bytes && after.digest === python.sha256 && after.tuple === before.tuple,
    "Protection interpreter changed during original observation",
  )
  const value = JSON.parse(output.stdout) as { sid?: unknown; protected?: unknown }
  check(
    output.stderr === "" &&
      Object.keys(value).sort().join() === "protected,sid" &&
      value.protected === true &&
      typeof value.sid === "string" &&
      /^S-1-(?:\d+-){1,15}\d+$/.test(value.sid),
    "Native managed root protection refused",
  )
  return value.sid
}
