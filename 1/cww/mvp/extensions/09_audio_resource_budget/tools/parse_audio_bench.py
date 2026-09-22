#!/usr/bin/env python3
"""Extract [BENCH] summary lines into a small CSV table."""

import csv
import re
import sys

PATTERN = re.compile(
    r"summary mode=(?P<mode>\S+) stage=(?P<stage>\S+) "
    r"count=(?P<count>\d+) avg_us=(?P<avg>\d+) "
    r"min_us=(?P<min>\d+) max_us=(?P<max>\d+)"
)

ZERO_PATTERN = re.compile(
    r"summary mode=(?P<mode>\S+) stage=(?P<stage>\S+) count=(?P<count>0)"
    r"(?: avg_us=0 min_us=0 max_us=0)?"
)


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} LOG_FILE", file=sys.stderr)
        return 2
    rows = []
    with open(sys.argv[1], encoding="utf-8") as log_file:
        for line in log_file:
            match = PATTERN.search(line)
            if match:
                rows.append(match.groupdict())
                continue
            zero_match = ZERO_PATTERN.search(line)
            if zero_match:
                rows.append({
                    **zero_match.groupdict(),
                    "avg": "0",
                    "min": "0",
                    "max": "0",
                })
    writer = csv.DictWriter(
        sys.stdout,
        fieldnames=["mode", "stage", "count", "avg", "min", "max"],
    )
    writer.writeheader()
    writer.writerows(rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
