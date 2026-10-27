"""The base class every generated model extends."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, model_validator


def reject_floats(value: Any, where: str = "value") -> None:
    """Raises TypeError if a float appears anywhere in `value`.

    A float cannot hold most decimal amounts exactly, so 0.1 + 0.2 would reach
    the API as 0.30000000000000004. Pass a `Decimal`, a string or an int.
    """
    if isinstance(value, float):
        raise TypeError(f"{where} is a float ({value!r}); pass a Decimal, a str or an int")
    if isinstance(value, dict):
        for key, item in value.items():
            reject_floats(item, f"{where}.{key}")
    elif isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            reject_floats(item, f"{where}[{index}]")


class Model(BaseModel):
    # Fields the pinned spec does not know yet are kept, not dropped.
    model_config = ConfigDict(extra="allow", populate_by_name=True)

    # A before-validator on the whole input also covers the extra fields.
    @model_validator(mode="before")
    @classmethod
    def _no_floats(cls, data: Any) -> Any:
        reject_floats(data, cls.__name__)
        return data
