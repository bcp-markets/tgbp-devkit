"""The tGBP Swap API client: USDC to tGBP and back.

Types come from the published spec, generated into swap_models.py.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Generic, Protocol, TypeVar

from pydantic import BaseModel, ValidationError

from . import _http
from ._http import HttpConfig, Transport, urllib_transport
from .client import describe, http_config, to_body, to_query
from .swap_models import (
    CancelSwapIntentResponse,
    Conversion,
    CreateConversionRequest,
    CreateConversionResponse,
    CreateDepositAddressResponse,
    CreateSwapIntentRequest,
    CreateSwapIntentResponse,
    Deposit,
    DepositBalance,
    DepositSession,
    GetDepositBalanceQuery,
    GetDepositBalanceResponse,
    GetDepositSessionResponse,
    GetLimitsResponse,
    GetQuoteQuery,
    GetQuoteResponse,
    GetSupportedNetworksResponse,
    GetSwapIntentResponse,
    ListDepositsQuery,
    ListDepositsResponse,
    Quote,
    SupportedNetwork,
    SwapIntent,
    SwapLimits,
)

T = TypeVar("T")
T_co = TypeVar("T_co", covariant=True)

# The swap API's SwapIntentId format.
SWAP_INTENT_ID = re.compile(r"[A-Za-z0-9_-]{6,128}")

SWAP_PRODUCTION_URL = "https://swap-api.tgbp.io"


@dataclass(frozen=True)
class SwapCreateResult(Generic[T]):
    data: T
    idempotency_key: str
    """The key the request was sent with. Keep it to retry the same request."""


class TgbpSwapClient:
    """The tGBP Swap API.

    `base_url` defaults to production; for staging, pass the swap host from your onboarding pack.
    """

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = SWAP_PRODUCTION_URL,
        transport: Transport = urllib_transport,
        timeout: float = 30.0,
        max_retries: int = 3,
        base_delay: float = 0.5,
    ) -> None:
        self._config: HttpConfig = http_config(api_key, base_url, transport, timeout, max_retries, base_delay)

    def get_quote(self, query: GetQuoteQuery) -> Quote:
        return self._get(GetQuoteResponse, "/api/quote", query)

    def get_limits(self) -> SwapLimits:
        return self._get(GetLimitsResponse, "/api/limits")

    def get_supported_networks(self) -> list[SupportedNetwork]:
        return self._get(GetSupportedNetworksResponse, "/api/supported-networks")

    def get_deposit_session(self) -> DepositSession:
        return self._get(GetDepositSessionResponse, "/api/deposit-session")

    def create_deposit_address(self) -> DepositSession:
        """Creates or recovers your deposit address (per the swap API reference), so a repeat is safe."""
        path = "/api/deposit-session/address"
        status, body = _http.request(self._config, "POST", path, retry=True)
        return _data(CreateDepositAddressResponse, "POST", path, status, body)

    def list_deposits(self, query: ListDepositsQuery) -> list[Deposit]:
        return self._get(ListDepositsResponse, "/api/deposits", query)

    def get_deposit_balance(self, query: GetDepositBalanceQuery) -> DepositBalance:
        """The balance deposited to your swap deposit address on one chain."""
        return self._get(GetDepositBalanceResponse, "/api/deposit-balance", query)

    def create_swap_intent(
        self, body: CreateSwapIntentRequest | Mapping[str, Any]
    ) -> SwapCreateResult[SwapIntent]:
        """Fix a firm quote before you fund a swap.

        The swap API dedupes intents on `id`, so a retry with the same `id` returns the same
        intent. Omit `id` and the client generates one.
        """
        path = "/api/swap-intents"
        payload = to_body(CreateSwapIntentRequest, body)
        intent_id = payload.get("id")
        if intent_id is None:
            intent_id = _http.generate_idempotency_key()
        if not isinstance(intent_id, str) or not SWAP_INTENT_ID.fullmatch(intent_id):
            raise ValueError(
                f'Invalid swap intent id "{intent_id}": use 6 to 128 letters, digits, "_" or "-"'
            )
        dedupe = ("swapIntentId", intent_id)
        status, res = _http.request(
            self._config, "POST", path, body={**payload, "id": intent_id}, dedupe_key=dedupe, retry=True
        )
        intent = _data(CreateSwapIntentResponse, "POST", path, status, res, dedupe_key=dedupe)
        return SwapCreateResult(data=intent, idempotency_key=intent_id)

    def get_swap_intent(self, id: str) -> SwapIntent:
        return self._get(GetSwapIntentResponse, "/api/swap-intents/{id}", path_params={"id": id})

    def cancel_swap_intent(self, id: str) -> SwapIntent:
        """Cancel an unfunded swap intent. Not retried: the reference does not say a repeat is safe."""
        path = "/api/swap-intents/{id}/cancel"
        status, body = _http.request(self._config, "POST", path, path_params={"id": id}, retry=False)
        return _data(CancelSwapIntentResponse, "POST", path, status, body)

    def create_conversion(
        self, body: CreateConversionRequest | Mapping[str, Any], *, idempotency_key: str | None = None
    ) -> SwapCreateResult[Conversion]:
        """Accept a swap for a confirmed deposit and settle it to the recipient."""
        path = "/api/conversions"
        key = idempotency_key if idempotency_key is not None else _http.generate_idempotency_key()
        _http.assert_idempotency_key(key)
        status, res = _http.request(
            self._config,
            "POST",
            path,
            body=to_body(CreateConversionRequest, body),
            idempotency_key=key,
            retry=True,
        )
        conversion = _data(CreateConversionResponse, "POST", path, status, res, idempotency_key=key)
        return SwapCreateResult(data=conversion, idempotency_key=key)

    def _get(
        self,
        model: _WrapperType[T],
        path: str,
        query: BaseModel | None = None,
        path_params: Mapping[str, str] | None = None,
    ) -> T:
        status, body = _http.request(
            self._config, "GET", path, query=to_query(query), path_params=path_params, retry=True
        )
        return _data(model, "GET", path, status, body)


class _Wrapped(Protocol[T_co]):
    @property
    def data(self) -> T_co | None: ...


class _WrapperType(Protocol[T_co]):
    """A generated swap response model: every swap response wraps its record in `data`."""

    def model_validate(self, obj: Any, /) -> _Wrapped[T_co]: ...


def _data(
    model: _WrapperType[T],
    method: str,
    path: str,
    status: int,
    body: Any,
    *,
    idempotency_key: str | None = None,
    dedupe_key: tuple[str, str] | None = None,
) -> T:
    """Validates a swap response against its spec model and returns the record in `data`."""
    keys: dict[str, Any] = {"idempotency_key": idempotency_key, "dedupe_key": dedupe_key}
    try:
        data = model.model_validate(body).data
    except ValidationError as err:
        raise _http.unexpected_body(method, path, status, body, describe(model, err), **keys) from err
    if data is None:
        raise _http.unexpected_body(method, path, status, body, "data", **keys)
    return data
