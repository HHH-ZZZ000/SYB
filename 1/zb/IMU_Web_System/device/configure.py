"""Configure the real ESP32-S3 locally. Passwords are never printed or passed on the CLI."""

import argparse
import getpass
import ipaddress
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import urlsplit
import uuid
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent


def saved_windows_wifi(profile):
    if os.name != "nt":
        raise ValueError("Saved Wi-Fi profiles are supported only on Windows.")
    scratch = ROOT / ".private" / uuid.uuid4().hex
    scratch.mkdir(parents=True)
    try:
        result = subprocess.run(
            ["netsh", "wlan", "export", "profile", f"name={profile}", f"folder={scratch}", "key=clear"],
            capture_output=True, timeout=15,
        )
        files = list(scratch.glob("*.xml"))
        if result.returncode or len(files) != 1:
            raise ValueError("Cannot read that saved Wi-Fi profile. Use --ssid and enter the password locally.")
        root = ET.parse(files[0]).getroot()
        ns = {"w": "http://www.microsoft.com/networking/WLAN/profile/v1"}
        ssid = root.findtext("w:SSIDConfig/w:SSID/w:name", namespaces=ns)
        password = root.findtext("w:MSM/w:security/w:sharedKey/w:keyMaterial", namespaces=ns)
        protected = root.findtext("w:MSM/w:security/w:sharedKey/w:protected", namespaces=ns)
        if not ssid or password is None or protected != "false":
            raise ValueError("Profile does not contain an available personal Wi-Fi password.")
        return ssid, password
    finally:
        # Only delete the files created in this specific scratch directory.
        for path in scratch.iterdir():
            if path.is_file() and path.resolve().parent == scratch.resolve():
                path.unlink()
        scratch.rmdir()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--windows-profile", help="Reuse this specific saved Windows Wi-Fi profile")
    group.add_argument("--ssid", help="2.4 GHz Wi-Fi name; password will be prompted privately")
    parser.add_argument("--server", required=True, help="Flask base URL, e.g. http://192.168.1.10:5000")
    args = parser.parse_args()
    try:
        url = urlsplit(args.server.rstrip("/"))
        host = ipaddress.IPv4Address(url.hostname or "")
        if (url.scheme != "http" or not host.is_private or host.is_loopback or host.is_unspecified
                or url.username or url.password or url.path or url.query or url.fragment
                or not 1 <= (url.port or 80) <= 65535):
            raise ValueError("Use a private LAN IPv4 HTTP base URL without a path or credentials.")
        if args.windows_profile:
            ssid, password = saved_windows_wifi(args.windows_profile)
        else:
            ssid = args.ssid or input("Wi-Fi SSID (2.4 GHz): ")
            password = getpass.getpass("Wi-Fi password (empty only for an open network): ")
        if not 1 <= len(ssid.encode("utf-8")) <= 32:
            raise ValueError("SSID must contain 1-32 UTF-8 bytes.")
        password_bytes = password.encode("utf-8")
        if password and not (8 <= len(password_bytes) <= 63 or
                             (len(password_bytes) == 64 and all(c in "0123456789abcdefABCDEF" for c in password))):
            raise ValueError("Personal Wi-Fi password must contain 8-63 bytes or a 64-digit hexadecimal PSK.")
        values = {"IMU_WIFI_SSID": ssid, "IMU_WIFI_PASSWORD": password,
                  "IMU_SERVER_BASE_URL": args.server.rstrip("/")}
        header = "#pragma once\n/* PRIVATE local configuration. Do not share or commit. */\n"
        header += "".join(f"#define {key} {json.dumps(value, ensure_ascii=False)}\n" for key, value in values.items())
        (ROOT / "main" / "config.local.h").write_text(header, encoding="utf-8")
        print(f"Configured local Wi-Fi and server {args.server.rstrip('/')}. Password omitted.")
    except (ValueError, OSError, subprocess.SubprocessError, ET.ParseError) as exc:
        parser.exit(1, f"Configuration failed: {exc}\n")


if __name__ == "__main__":
    main()
