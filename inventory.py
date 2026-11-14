#!/usr/bin/env python3
"""Project-owned UI inventory: one `kind|name|locator` line per control."""
import re
from pathlib import Path


def main() -> int:
    source = "\n".join(path.read_text(encoding="utf-8") for path in sorted(Path("src").glob("*.tsx")))
    ids = sorted(set(re.findall(r'data-testid="([^"]+)"', source)))
    for name in ids:
        print(f'control|{name}|[data-testid="{name}"]')
    print("cli|demo|npm run demo")
    print("cli|verify|npm run verify")
    print("cli|dogfood|npm run dogfood")
    print("cli|browser|npm run test:browser")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
