#!/usr/bin/env python3
"""Small, import-safe bridge for manifest-declared image providers.

Private content is read from a file instead of argv.  Provider output streams and
exception messages are deliberately swallowed so a provider cannot copy private
input into the parent process logs.
"""

import contextlib
import ctypes
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys
import threading
import time
import types

try:
    import resource
except ImportError:  # Windows
    resource = None


_windows_job = None


def kill_process_family(*_ignored):
    if os.name == "nt":
        os._exit(1)
    try:
        os.killpg(os.getpgrp(), 9)
    except BaseException:
        os._exit(1)


def configure_windows_job():
    global _windows_job
    if os.name != "nt":
        return

    from ctypes import wintypes

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [
            ("ReadOperationCount", ctypes.c_ulonglong),
            ("WriteOperationCount", ctypes.c_ulonglong),
            ("OtherOperationCount", ctypes.c_ulonglong),
            ("ReadTransferCount", ctypes.c_ulonglong),
            ("WriteTransferCount", ctypes.c_ulonglong),
            ("OtherTransferCount", ctypes.c_ulonglong),
        ]

    class BASIC_LIMITS(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_longlong),
            ("PerJobUserTimeLimit", ctypes.c_longlong),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class EXTENDED_LIMITS(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", BASIC_LIMITS),
            ("IoInfo", IO_COUNTERS),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel32.SetInformationJobObject.restype = wintypes.BOOL
    kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    job = kernel32.CreateJobObjectW(None, None)
    if not job:
        raise RuntimeError("provider containment unavailable")
    limits = EXTENDED_LIMITS()
    limits.BasicLimitInformation.LimitFlags = 0x00002000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not kernel32.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
        kernel32.CloseHandle(job)
        raise RuntimeError("provider containment unavailable")
    if not kernel32.AssignProcessToJobObject(job, kernel32.GetCurrentProcess()):
        kernel32.CloseHandle(job)
        raise RuntimeError("provider containment unavailable")
    _windows_job = job


def configure_parent_death():
    expected = int(os.environ["SUPERPPT_BRIDGE_PARENT_PID"])
    if expected <= 1:
        raise RuntimeError("provider parent identity is invalid")
    configure_windows_job()
    if sys.platform.startswith("linux"):
        signal = __import__("signal")
        signal.signal(signal.SIGTERM, kill_process_family)
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0:  # PR_SET_PDEATHSIG
            raise RuntimeError("provider parent-death containment unavailable")
    if os.getppid() != expected:
        kill_process_family()

    def watch_parent():
        while os.getppid() == expected:
            time.sleep(0.025)
        kill_process_family()

    threading.Thread(target=watch_parent, name="superppt-parent-watch", daemon=True).start()


def regular_private_file(path_string):
    if path_string == "@fd:3":
        info = os.fstat(3)
        if os.name != "nt" and (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600):
            raise RuntimeError("private input descriptor is invalid")
        return os.fdopen(os.dup(3), "r", encoding="utf-8")
    path = Path(path_string)
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise RuntimeError("private input must be a regular file")
    if os.name != "nt" and stat.S_IMODE(info.st_mode) != 0o600:
        raise RuntimeError("private input permissions are invalid")
    return path


def load_module(path_string):
    module_fd = os.environ.get("SUPERPPT_BRIDGE_MODULE_FD")
    if module_fd is not None:
        descriptor = int(module_fd)
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise RuntimeError("provider module descriptor is invalid")
        with os.fdopen(os.dup(descriptor), "r", encoding="utf-8") as handle:
            source = handle.read()
        module = types.ModuleType("superppt_external_provider")
        module.__file__ = path_string
        module.__package__ = ""
        provider_directory = str(Path(path_string).resolve().parent)
        sys.path.insert(0, provider_directory)
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                exec(compile(source, path_string, "exec"), module.__dict__)
        finally:
            if sys.path and sys.path[0] == provider_directory:
                sys.path.pop(0)
        return module
    path = Path(path_string)
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise RuntimeError("provider module must be a regular file")
    spec = importlib.util.spec_from_file_location("superppt_external_provider", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("provider module cannot be loaded")
    module = importlib.util.module_from_spec(spec)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        spec.loader.exec_module(module)
    return module


def read_private(private):
    if hasattr(private, "read"):
        try:
            return private.read()
        finally:
            private.close()
    return private.read_text(encoding="utf-8")


def invoke(function, *args):
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        return function(*args)


def apply_output_limit():
    value = os.environ.get("SUPERPPT_BRIDGE_MAX_OUTPUT_BYTES")
    if value is None or resource is None:
        return
    maximum = int(value)
    if maximum <= 0:
        raise RuntimeError("provider output limit is invalid")
    resource.setrlimit(resource.RLIMIT_FSIZE, (maximum, maximum))


def main(argv):
    if len(argv) != 6 or argv[1] not in {"generate", "review"}:
        raise RuntimeError("invalid provider bridge invocation")
    mode, module_path, callable_name, private_path, target = argv[1:]
    configure_parent_death()
    private = regular_private_file(private_path)
    function = getattr(load_module(module_path), callable_name)
    if not callable(function):
        raise RuntimeError("provider callable is invalid")
    if mode == "generate":
        apply_output_limit()
        prompt = read_private(private)
        ok = bool(invoke(function, prompt, target, 0))
        prompt = None
        if not ok:
            raise RuntimeError("provider returned failure")
        return
    request = json.loads(read_private(private))
    if not isinstance(request, dict) or set(request) != {"question"} or not isinstance(request["question"], str):
        raise RuntimeError("private review request is invalid")
    result = invoke(function, target, request["question"])
    sys.stdout.write(result if isinstance(result, str) else json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main(sys.argv)
    except BaseException as exc:
        # Never render provider messages: they may contain the prompt, keys, or
        # module import diagnostics.  The type alone is sufficient for callers.
        sys.stderr.write(f"provider bridge failed: {type(exc).__name__}\n")
        raise SystemExit(1)
