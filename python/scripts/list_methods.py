"""Prints the Python clients' public API operations as JSON, for scripts/check-python-parity.ts.

{"TgbpClient": ["mints.cancel", ...], "TgbpSwapClient": ["cancel_swap_intent", ...]}
"""

from __future__ import annotations

import inspect
import json

from tgbp_kit import TgbpClient, TgbpSwapClient


def operations(obj: object, prefix: str = "") -> list[str]:
    names = []
    for name, value in inspect.getmembers(obj):
        if name.startswith("_"):
            continue
        if inspect.ismethod(value):
            names.append(prefix + name)
        elif type(value).__module__.startswith("tgbp_kit."):
            names.extend(operations(value, f"{prefix}{name}."))
    return sorted(names)


clients = {
    "TgbpClient": TgbpClient(api_key="parity", environment="sandbox"),
    "TgbpSwapClient": TgbpSwapClient(api_key="parity"),
}
print(json.dumps({name: operations(client) for name, client in clients.items()}))
