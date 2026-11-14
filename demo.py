#!/usr/bin/env python3
"""Headless scripted drive: prints WORLD-DELTA lines, no input, exits 0."""
import subprocess
import sys
import time


def _seed(argv):
    if "--seed" in argv:
        index = argv.index("--seed")
        try:
            return int(argv[index + 1])
        except (IndexError, ValueError):
            print("Usage: python demo.py --scripted [--seed N]", file=sys.stderr)
            return None
    return 0


def main() -> int:
    if "--scripted" not in sys.argv:
        print("Usage: python demo.py --scripted [--seed N]", file=sys.stderr)
        return 2
    seed = _seed(sys.argv)
    if seed is None:
        return 2
    started = time.perf_counter()
    result = subprocess.run(
        ["node", "scripts/dogfood.mjs"],
        check=False,
        timeout=120,
        text=True,
        capture_output=True,
    )
    elapsed = int((time.perf_counter() - started) * 1000)
    sys.stdout.write(result.stdout)
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        return 1
    print(f"SEED: {seed}")
    print(f"WORLD-DELTA: dogfood_ms={elapsed}")
    print("OK: scripted drive complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
