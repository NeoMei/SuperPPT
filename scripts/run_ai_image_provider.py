#!/usr/bin/env python3
"""Small, import-safe bridge for manifest-declared image providers.

Private content is read from a file instead of argv.  Provider output streams and
exception messages are deliberately swallowed so a provider cannot copy private
input into the parent process logs.
"""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys
import types


def regular_private_file(path_string):
    if path_string == "@fd:3":
        info = os.fstat(3)
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600:
            raise RuntimeError("private input descriptor is invalid")
        return os.fdopen(os.dup(3), "r", encoding="utf-8")
    path = Path(path_string)
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise RuntimeError("private input must be a regular file")
    if stat.S_IMODE(info.st_mode) != 0o600:
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


def main(argv):
    if len(argv) != 6 or argv[1] not in {"generate", "review"}:
        raise RuntimeError("invalid provider bridge invocation")
    mode, module_path, callable_name, private_path, target = argv[1:]
    private = regular_private_file(private_path)
    function = getattr(load_module(module_path), callable_name)
    if not callable(function):
        raise RuntimeError("provider callable is invalid")
    if mode == "generate":
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
