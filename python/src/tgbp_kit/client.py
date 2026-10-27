"""The tGBP API client: mint and redeem. Types come from the published spec, generated into models.py."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Generic, Literal, TypeVar

from pydantic import BaseModel, ValidationError

from . import _http
from ._http import HttpConfig, Transport, urllib_transport
from .models import (
    BurnConfirmationRequest,
    BurnConfirmationResponse,
    CancelRequest,
    ListMintsQuery,
    ListRedemptionsQuery,
    Mint,
    MintCreateRequest,
    MintListResponse,
    MintResponse,
    Redemption,
    RedemptionCreateRequest,
    RedemptionListResponse,
    RedemptionQuoteRequest,
    RedemptionQuoteResponse,
    RedemptionResponse,
    SimulateMintPayinResponse,
)

T = TypeVar("T")
M = TypeVar("M", bound=BaseModel)

TgbpEnvironment = Literal["production", "sandbox"]

API_BASE_URLS: dict[str, str] = {
    "production": "https://api.tgbp.io",
    # Takes staging keys and runs on testnets only.
    "sandbox": "https://sandbox.tgbp.io",
}


@dataclass(frozen=True)
class Created(Generic[T]):
    """`created` is a new record; `replayed` is the record an earlier request with the same key created."""

    status: Literal["created", "replayed"]
    data: T
    idempotency_key: str


@dataclass(frozen=True)
class PendingApproval:
    """Your account needs a second person to approve the action: nothing exists yet, so do not retry."""

    approval_request_id: str
    idempotency_key: str
    status: Literal["pending_approval"] = "pending_approval"


def http_config(
    api_key: str,
    base_url: str,
    transport: Transport,
    timeout: float,
    max_retries: int,
    base_delay: float,
) -> HttpConfig:
    return HttpConfig(
        api_key=api_key,
        base_url=_http.normalise_base_url(base_url),
        transport=transport,
        timeout=timeout,
        max_retries=max_retries,
        base_delay=base_delay,
    )


def to_body(model: type[M], body: M | Mapping[str, Any]) -> dict[str, Any]:
    """Validates a request body against its spec model; only the fields you set are sent."""
    value = body if isinstance(body, model) else model.model_validate(body)
    dumped = value.model_dump(mode="python", by_alias=True, exclude_unset=True)
    # The deprecated body field: the API could dedupe on it instead of the header key the client reports.
    if "IdempotencyKey" in dumped:
        raise ValueError("pass idempotency_key= instead of an IdempotencyKey field in the body")
    return dumped


def describe(model: object, err: ValidationError) -> str:
    """Names the spec model and the first fields that failed it."""
    fields = ", ".join(".".join(map(str, e["loc"])) or "(body)" for e in err.errors()[:5])
    return f"a body matching {getattr(model, '__name__', 'the spec')} (failed at {fields})"


def to_query(query: BaseModel | None) -> dict[str, Any]:
    return {} if query is None else query.model_dump(mode="python", by_alias=True, exclude_none=True)


def parse(
    model: type[M],
    method: str,
    path: str,
    status: int,
    body: Any,
    *,
    idempotency_key: str | None = None,
    dedupe_key: tuple[str, str] | None = None,
) -> M:
    """Validates a success body against its spec model."""
    try:
        return model.model_validate(body)
    except ValidationError as err:
        raise _http.unexpected_body(
            method,
            path,
            status,
            body,
            describe(model, err),
            idempotency_key=idempotency_key,
            dedupe_key=dedupe_key,
        ) from err


class Mints:
    def __init__(self, config: HttpConfig) -> None:
        self._config = config

    def create(
        self, body: MintCreateRequest | Mapping[str, Any], *, idempotency_key: str | None = None
    ) -> Created[Mint] | PendingApproval:
        """Create a mint. tGBP is minted to `destinationAddress` once the bank transfer arrives.

        Reuse a key only to retry the same request; a key lasts 24 hours. Omit it and the
        client generates one, returned on the result and on any error.
        """
        return _create(self._config, "/api/v1/mints", to_body(MintCreateRequest, body), Mint, idempotency_key)

    def get(self, mint_id: str) -> MintResponse:
        path = "/api/v1/mints/{mintId}"
        status, body = _http.request(self._config, "GET", path, path_params={"mintId": mint_id}, retry=True)
        return parse(MintResponse, "GET", path, status, body)

    def list(self, query: ListMintsQuery | None = None) -> MintListResponse:
        path = "/api/v1/mints"
        status, body = _http.request(self._config, "GET", path, query=to_query(query), retry=True)
        return parse(MintListResponse, "GET", path, status, body)

    def cancel(self, mint_id: str, body: CancelRequest | Mapping[str, Any] | None = None) -> MintResponse:
        """Cancel a pending mint.

        Retried: the API reference's idempotency guide says a repeated cancel returns the
        current state or a 409.
        """
        path = "/api/v1/mints/{mintId}/cancel"
        status, res = _http.request(
            self._config,
            "POST",
            path,
            path_params={"mintId": mint_id},
            body=None if body is None else to_body(CancelRequest, body),
            retry=True,
        )
        return parse(MintResponse, "POST", path, status, res)

    def simulate_payin(self, mint_id: str) -> SimulateMintPayinResponse:
        """Sandbox only: simulate the bank transfer for a pending mint.

        Never retried, because a second call can race the first.
        """
        path = "/api/v1/mints/{mintId}/simulate-payin"
        status, body = _http.request(self._config, "POST", path, path_params={"mintId": mint_id}, retry=False)
        return parse(SimulateMintPayinResponse, "POST", path, status, body)


class Redemptions:
    def __init__(self, config: HttpConfig) -> None:
        self._config = config

    def create(
        self, body: RedemptionCreateRequest | Mapping[str, Any], *, idempotency_key: str | None = None
    ) -> Created[Redemption] | PendingApproval:
        """Create a redemption.

        Then burn the tGBP by sending it to the returned `burnAddress`; GBP is paid out to
        `bankId` once the burn confirms.
        """
        body_json = to_body(RedemptionCreateRequest, body)
        return _create(self._config, "/api/v1/redemptions", body_json, Redemption, idempotency_key)

    def get(self, redemption_id: str) -> RedemptionResponse:
        path = "/api/v1/redemptions/{redemptionId}"
        status, body = _http.request(
            self._config, "GET", path, path_params={"redemptionId": redemption_id}, retry=True
        )
        return parse(RedemptionResponse, "GET", path, status, body)

    def list(self, query: ListRedemptionsQuery | None = None) -> RedemptionListResponse:
        path = "/api/v1/redemptions"
        status, body = _http.request(self._config, "GET", path, query=to_query(query), retry=True)
        return parse(RedemptionListResponse, "GET", path, status, body)

    def cancel(
        self, redemption_id: str, body: CancelRequest | Mapping[str, Any] | None = None
    ) -> RedemptionResponse:
        """Cancel a pending redemption.

        Retried: the API reference's idempotency guide says a repeated cancel returns the
        current state or a 409.
        """
        path = "/api/v1/redemptions/{redemptionId}/cancel"
        status, res = _http.request(
            self._config,
            "POST",
            path,
            path_params={"redemptionId": redemption_id},
            body=None if body is None else to_body(CancelRequest, body),
            retry=True,
        )
        return parse(RedemptionResponse, "POST", path, status, res)

    def quote(self, body: RedemptionQuoteRequest | Mapping[str, Any]) -> RedemptionQuoteResponse:
        """Screen the address that will send the burn, before you burn. Creates no record."""
        path = "/api/v1/redemptions/quote"
        status, res = _http.request(
            self._config, "POST", path, body=to_body(RedemptionQuoteRequest, body), retry=True
        )
        return parse(RedemptionQuoteResponse, "POST", path, status, res)

    def confirm_burn(
        self, redemption_id: str, body: BurnConfirmationRequest | Mapping[str, Any] | None = None
    ) -> BurnConfirmationResponse:
        """Fallback when the burn is not detected on its own.

        The API reference says it is safe to call more than once: the payout is never sent twice.
        """
        path = "/api/v1/redemptions/{redemptionId}/burn-confirmation"
        status, res = _http.request(
            self._config,
            "POST",
            path,
            path_params={"redemptionId": redemption_id},
            body=None if body is None else to_body(BurnConfirmationRequest, body),
            retry=True,
        )
        return parse(BurnConfirmationResponse, "POST", path, status, res)


class TgbpClient:
    """The tGBP mint and redeem API.

    Pass `environment` ("production" or "sandbox") or a `base_url`, not both.
    `sandbox` takes staging keys and runs on testnets only.
    """

    def __init__(
        self,
        *,
        api_key: str,
        environment: TgbpEnvironment | None = None,
        base_url: str | None = None,
        transport: Transport = urllib_transport,
        timeout: float = 30.0,
        max_retries: int = 3,
        base_delay: float = 0.5,
    ) -> None:
        if (environment is None) == (base_url is None):
            raise ValueError("pass either environment or base_url")
        if base_url is None:
            if environment not in API_BASE_URLS:
                raise ValueError(f"unknown environment {environment!r}")
            base_url = API_BASE_URLS[environment]
        config = http_config(api_key, base_url, transport, timeout, max_retries, base_delay)
        self.mints = Mints(config)
        self.redemptions = Redemptions(config)


def _create(
    config: HttpConfig,
    path: str,
    body: dict[str, Any],
    model: type[M],
    idempotency_key: str | None,
) -> Created[M] | PendingApproval:
    key = idempotency_key if idempotency_key is not None else _http.generate_idempotency_key()
    _http.assert_idempotency_key(key)
    status, res = _http.request(config, "POST", path, body=body, idempotency_key=key, retry=True)
    # Only these mean what the result reports; any other 2xx leaves the record's fate unknown.
    if status not in (200, 201, 202):
        raise _http.incomplete_create(path, status, res, key, "a recognised status (200, 201 or 202)")
    data = res.get("data") if isinstance(res, dict) else None
    if status == 202:
        approval_id = data.get("approval_request_id") if isinstance(data, dict) else None
        if not isinstance(approval_id, str) or approval_id == "":
            raise _http.incomplete_create(path, status, res, key, "an approval_request_id")
        return PendingApproval(approval_request_id=approval_id, idempotency_key=key)
    if not isinstance(data, dict):
        raise _http.incomplete_create(path, status, res, key, "the created record")
    record = parse(model, "POST", path, status, data, idempotency_key=key)
    return Created(status="replayed" if status == 200 else "created", data=record, idempotency_key=key)
