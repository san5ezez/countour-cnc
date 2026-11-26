"""Build a standalone Windows x64 executable, including when run on Linux."""

import argparse
import hashlib
import os
import shutil
import subprocess
import tempfile
from io import BytesIO
from pathlib import Path
from urllib.request import urlopen
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[2]
PYTHON_VERSION = "3.13.17"
PYTHON_SHA256 = "9e35319bffedab8b36ad44d8f377cb4f1733bcec257a0b6d04d94f01486ddb38"
PYSERIAL_URL = (
    "https://files.pythonhosted.org/packages/07/bc/"
    "587a445451b253b285629263eb51c2d8e9bcea4fc97826266d186f96f558/"
    "pyserial-3.5-py2.py3-none-any.whl"
)
PYSERIAL_SHA256 = "c4451db6ba391ca6ca299fb3ec7bae67a5c55dde170964c7a14ceefec02f2cf0"


def fetch_zip(url, checksum):
    with urlopen(url, timeout=60) as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest() != checksum:
        raise ValueError(f"Checksum mismatch for {url}")
    return ZipFile(BytesIO(data))


def create_payload(path, go_license):
    python = f"https://www.python.org/ftp/python/{PYTHON_VERSION}/python-{PYTHON_VERSION}-embed-amd64.zip"
    with (
        ZipFile(path, "w", ZIP_DEFLATED) as payload,
        fetch_zip(python, PYTHON_SHA256) as runtime,
        fetch_zip(PYSERIAL_URL, PYSERIAL_SHA256) as serial,
    ):
        for member in sorted(runtime.namelist()):
            if not member.endswith(("/", "._pth")):
                payload.writestr(member, runtime.read(member))
        payload.writestr("Go-LICENSE.txt", go_license.read_bytes())
        payload.writestr("python313._pth", "python313.zip\n.\napp\n")
        for member in sorted(serial.namelist()):
            if not member.endswith("/"):
                payload.writestr(f"app/{member}", serial.read(member))
        for source in [
            ROOT / "app.py", ROOT / "sender.py", ROOT / "program_edit.py", ROOT / "README.md",
            *sorted((ROOT / "web").iterdir()), ROOT / "examples" / "rosette.nc",
        ]:
            payload.writestr(f"app/{source.relative_to(ROOT).as_posix()}", source.read_bytes())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="path to the resulting .exe")
    parser.add_argument("--go", default="go", help="Go 1.23+ executable")
    args = parser.parse_args()
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    go_root = Path(subprocess.check_output([args.go, "env", "GOROOT"], text=True).strip())
    with tempfile.TemporaryDirectory(prefix="contour-build-") as temp:
        staging = Path(temp)
        create_payload(staging / "payload.zip", go_root / "LICENSE")
        shutil.copyfile(Path(__file__).with_name("launcher.go"), staging / "launcher.go")
        env = dict(os.environ, GOOS="windows", GOARCH="amd64", CGO_ENABLED="0")
        subprocess.run(
            [args.go, "build", "-trimpath", "-ldflags=-s -w", "-o", str(output), "launcher.go"],
            cwd=staging, env=env, check=True,
        )


if __name__ == "__main__":
    main()
