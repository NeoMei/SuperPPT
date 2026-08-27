import base64
import os


PIXEL = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def gen(prompt, out_path, retries=0):
    counter_path = os.environ.get("SUPERPPT_TEST_CALL_COUNTER")
    if counter_path:
        with open(counter_path, "a", encoding="utf-8") as handle:
            handle.write("1\n")
    mode_path = os.environ.get("SUPERPPT_TEST_MODE_PATH")
    if mode_path:
        with open(mode_path, "w", encoding="utf-8") as handle:
            handle.write(oct(os.stat(os.environ["SUPERPPT_TEST_PRIVATE_PATH"]).st_mode & 0o777))
    with open(out_path, "wb") as handle:
        handle.write(PIXEL)
    return True


def noisy_failure(prompt, out_path, retries=0):
    print(prompt)
    raise RuntimeError(prompt)
