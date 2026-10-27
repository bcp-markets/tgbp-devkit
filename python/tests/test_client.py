from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

import pytest

from tgbp_kit import (
    Created,
    HttpRequest,
    PendingApproval,
    TgbpClient,
    TgbpKitError,
    TgbpSwapClient,
    __version__,
    generate_idempotency_key,
)
from tgbp_kit._http import encode_json
from tgbp_kit.models import Amount, ListMintsQuery, ListRedemptionsQuery, MintCreateRequest
from tgbp_kit.swap_models import GetQuoteQuery

from .conftest import FakeTransport, fixture, reply

MINT_BODY: dict[str, Any] = {
    "customerId": "customer_1",
    "destinationAddress": "0x1111111111111111111111111111111111111111",
    "chain": "sepolia",
    "amount": {"currency": "GBP", "value": Decimal("10.10")},
}


def created(record: str, status: int = 201) -> Any:
    return reply(status, {"data": fixture(record)})


class TestAmounts:
    def test_a_float_amount_raises_type_error(self, client: TgbpClient) -> None:
        body = {**MINT_BODY, "amount": {"currency": "GBP", "value": 10.1}}
        with pytest.raises(TypeError, match="float"):
            client.mints.create(body)
        with pytest.raises(TypeError, match="float"):
            Amount(currency="GBP", value=10.1)

    def test_a_float_anywhere_in_a_body_raises_type_error(self, client: TgbpClient) -> None:
        with pytest.raises(TypeError, match="float"):
            client.mints.create({**MINT_BODY, "note": [1.5]})
        with pytest.raises(TypeError, match="float"):
            encode_json({"value": 0.1})

    def test_sends_a_decimal_as_a_json_number_digit_for_digit(
        self, client: TgbpClient, transport: FakeTransport
    ) -> None:
        transport.replies.append(created("mint"))
        client.mints.create({**MINT_BODY, "amount": {"currency": "GBP", "value": Decimal("1234567.89")}})
        assert transport.calls[0].body["amount"]["value"] == Decimal("1234567.89")
        assert encode_json({"v": Decimal("0.10")}) == '{"v":0.10}'
        assert encode_json({"v": 10}) == '{"v":10}'

    def test_reads_amounts_as_decimal_never_float(self, client: TgbpClient, transport: FakeTransport) -> None:
        transport.replies.append(reply(200, {"data": fixture("mint")}))
        mint = client.mints.get("mint_1").data
        assert isinstance(mint.amount.value, Decimal)
        assert mint.amount.value == Decimal("10.10")

    def test_accepts_str_and_int_amounts(self, client: TgbpClient, transport: FakeTransport) -> None:
        transport.replies.extend([created("mint"), created("mint")])
        client.mints.create({**MINT_BODY, "amount": {"currency": "GBP", "value": "12.50"}})
        client.mints.create({**MINT_BODY, "amount": {"currency": "GBP", "value": 12}})
        assert transport.calls[0].body["amount"]["value"] == Decimal("12.50")
        assert transport.calls[1].body["amount"]["value"] == 12


class TestRequests:
    def test_sends_the_api_key_and_user_agent(self, client: TgbpClient, transport: FakeTransport) -> None:
        transport.replies.append(reply(200, {"data": fixture("mint")}))
        client.mints.get("mint_1")
        call = transport.calls[0]
        assert call.url == "https://sandbox.tgbp.io/api/v1/mints/mint_1"
        assert call.headers["x-api-key"] == "tgbp_sandbox_test"
        assert call.headers["user-agent"] == f"tgbp-kit-python/{__version__}"
        assert call.headers["accept"] == "application/json"

    def test_sends_only_the_fields_you_set(self, client: TgbpClient, transport: FakeTransport) -> None:
        transport.replies.append(created("mint"))
        client.mints.create(MintCreateRequest.model_validate(MINT_BODY))
        assert transport.calls[0].body == MINT_BODY
        assert transport.calls[0].headers["content-type"] == "application/json"

    def test_refuses_plain_http_except_to_this_machine(self) -> None:
        with pytest.raises(ValueError, match="https"):
            TgbpClient(api_key="k", base_url="http://api.example.test")
        TgbpClient(api_key="k", base_url="http://localhost:8080/")

    def test_takes_an_environment_or_a_base_url_not_both(self) -> None:
        with pytest.raises(ValueError, match="either"):
            TgbpClient(api_key="k")
        with pytest.raises(ValueError, match="either"):
            TgbpClient(api_key="k", environment="sandbox", base_url="https://sandbox.tgbp.io")

    def test_encodes_path_parameters(self, client: TgbpClient, transport: FakeTransport) -> None:
        transport.replies.append(reply(200, {"data": fixture("mint")}))
        client.mints.get("a/b c")
        assert transport.calls[0].url.endswith("/api/v1/mints/a%2Fb%20c")

    def test_rejects_dot_segment_ids_and_a_base_url_with_a_query(self, client: TgbpClient) -> None:
        for bad in ("", ".", ".."):
            with pytest.raises(ValueError, match="path parameter"):
                client.mints.get(bad)
        with pytest.raises(ValueError, match="query"):
            TgbpClient(api_key="k", base_url="https://api.tgbp.io?x=1")

    def test_builds_the_query_from_the_spec_model(self, client: TgbpClient, transport: FakeTransport) -> None:
        transport.replies.append(reply(200, {"data": [fixture("mint")], "pagination": fixture("pagination")}))
        since = datetime(2026, 10, 1, tzinfo=timezone.utc)
        page = client.mints.list(ListMintsQuery(status=["pending", "paid"], from_=since, per_page=50))
        assert page.data[0].id == "mint_1"
        assert transport.calls[0].query == {
            "status": ["pending", "paid"],
            "from": ["2026-10-01T00:00:00+00:00"],
            "per_page": ["50"],
        }

    def test_sends_no_query_by_default(self, client: TgbpClient, transport: FakeTransport) -> None:
        transport.replies.append(reply(200, {"data": [], "pagination": fixture("pagination")}))
        client.redemptions.list()
        assert transport.calls[0].url == "https://sandbox.tgbp.io/api/v1/redemptions"
        transport.replies.append(reply(200, {"data": [], "pagination": fixture("pagination")}))
        client.redemptions.list(ListRedemptionsQuery(page=2))
        assert transport.calls[1].query == {"page": ["2"]}


class TestIdempotency:
    def test_generated_keys_fit_the_api_format(self) -> None:
        keys = {generate_idempotency_key() for _ in range(200)}
        assert len(keys) == 200
        assert all(re.fullmatch(r"[A-Za-z0-9_-]{18}", key) for key in keys)

    def test_sends_a_generated_key_on_every_create(
        self, client: TgbpClient, transport: FakeTransport
    ) -> None:
        transport.replies.extend([created("mint"), created("redemption")])
        mint = client.mints.create(MINT_BODY)
        redemption = client.redemptions.create(
            {"chain": "sepolia", "bankId": "bank_1", "amount": {"currency": "GBP", "value": 5}}
        )
        assert isinstance(mint, Created) and isinstance(redemption, Created)
        assert transport.calls[0].headers["idempotency-key"] == mint.idempotency_key
        assert transport.calls[1].headers["idempotency-key"] == redemption.idempotency_key
        assert mint.idempotency_key != redemption.idempotency_key
        assert mint.status == "created" and mint.data.id == "mint_1"
        assert redemption.data.burnAddress.startswith("0x")

    def test_uses_a_caller_key_and_rejects_one_the_api_would_refuse(
        self, client: TgbpClient, transport: FakeTransport
    ) -> None:
        transport.replies.append(created("mint"))
        result = client.mints.create(MINT_BODY, idempotency_key="order-42")
        assert result.idempotency_key == "order-42"
        assert transport.calls[0].headers["idempotency-key"] == "order-42"
        with pytest.raises(ValueError, match="idempotency key"):
            client.mints.create(MINT_BODY, idempotency_key="x" * 19)
        assert len(transport.calls) == 1

    def test_reports_a_replay_and_an_approval_gated_create(
        self, client: TgbpClient, transport: FakeTransport
    ) -> None:
        transport.replies.extend(
            [created("mint", 200), reply(202, {"data": {"approval_request_id": "apr_1"}})]
        )
        replay = client.mints.create(MINT_BODY, idempotency_key="k1")
        gated = client.mints.create(MINT_BODY, idempotency_key="k2")
        assert isinstance(replay, Created) and replay.status == "replayed"
        assert gated == PendingApproval(approval_request_id="apr_1", idempotency_key="k2")

    def test_sends_a_generated_key_on_a_conversion(
        self, swap: TgbpSwapClient, transport: FakeTransport
    ) -> None:
        transport.replies.append(reply(201, {"data": {"id": "conv_1", "status": "requested"}}))
        result = swap.create_conversion({"chainId": "sepolia"})
        assert transport.calls[0].headers["idempotency-key"] == result.idempotency_key
        assert result.data.id == "conv_1"

    def test_gives_a_swap_intent_a_generated_id(self, swap: TgbpSwapClient, transport: FakeTransport) -> None:
        transport.replies.append(reply(201, {"data": fixture("swap_intent")}))
        result = swap.create_swap_intent(
            {
                "chainId": "sepolia",
                "direction": "USDC_TO_TGBP",
                "recipientAddress": "0x1111111111111111111111111111111111111111",
                "sourceAmount": "100",
                "sourceRawAmount": "100000000",
            }
        )
        assert transport.calls[0].body["id"] == result.idempotency_key
        assert "idempotency-key" not in transport.calls[0].headers
        # pydantic's ValidationError is a ValueError.
        with pytest.raises(ValueError, match="id"):
            swap.create_swap_intent(
                {
                    "id": "short",
                    "chainId": "sepolia",
                    "direction": "USDC_TO_TGBP",
                    "recipientAddress": "0x1111111111111111111111111111111111111111",
                    "sourceAmount": "100",
                    "sourceRawAmount": "100000000",
                }
            )


class TestRetries:
    def test_retries_a_network_error_and_a_5xx_with_the_same_key(
        self, client: TgbpClient, transport: FakeTransport
    ) -> None:
        transport.replies.extend([ConnectionResetError("reset"), reply(503, {}), created("mint")])
        result = client.mints.create(MINT_BODY)
        keys = {call.headers["idempotency-key"] for call in transport.calls}
        assert len(transport.calls) == 3 and keys == {result.idempotency_key}

    def test_does_not_retry_a_4xx(self, client: TgbpClient, transport: FakeTransport) -> None:
        transport.replies.append(reply(429, {"error": {"code": "rate_limited", "message": "slow down"}}))
        with pytest.raises(TgbpKitError) as caught:
            client.mints.get("mint_1")
        assert len(transport.calls) == 1
        assert caught.value.code == "API_ERROR"
        assert caught.value.details["apiCode"] == "rate_limited"
        assert caught.value.details["mayHaveTakenEffect"] is False

    def test_tells_the_caller_to_keep_the_key_after_a_keyed_409(
        self, client: TgbpClient, transport: FakeTransport
    ) -> None:
        transport.replies.append(reply(409, {"error": {"code": "duplicate_request", "message": "in flight"}}))
        with pytest.raises(TgbpKitError, match="retry only with the same idempotency key") as caught:
            client.mints.create(MINT_BODY, idempotency_key="k1")
        assert caught.value.details["mayHaveTakenEffect"] is True

    def test_does_not_after_a_409_that_created_nothing(
        self, client: TgbpClient, transport: FakeTransport
    ) -> None:
        transport.replies.append(
            reply(409, {"error": {"code": "duplicate_active_mint", "message": "exists"}})
        )
        with pytest.raises(TgbpKitError) as caught:
            client.mints.create(MINT_BODY)
        assert caught.value.details["mayHaveTakenEffect"] is False

    def test_gives_up_after_max_retries_and_names_the_key(self, transport: FakeTransport) -> None:
        client = TgbpClient(
            api_key="k", environment="sandbox", transport=transport, max_retries=1, base_delay=0
        )
        transport.replies.extend([TimeoutError(), TimeoutError()])
        with pytest.raises(TgbpKitError, match="timed out.*same idempotency key \\(k1\\)") as caught:
            client.mints.create(MINT_BODY, idempotency_key="k1")
        assert caught.value.code == "API_UNREACHABLE"
        assert caught.value.details["attempts"] == 2
        assert caught.value.details["idempotencyKey"] == "k1"

    def test_names_the_swap_intent_id_when_a_create_gets_no_response(self, transport: FakeTransport) -> None:
        swap = TgbpSwapClient(api_key="k", transport=transport, max_retries=0)
        transport.replies.append(OSError("down"))
        with pytest.raises(TgbpKitError, match="same swapIntentId \\(intent_000001\\)") as caught:
            swap.create_swap_intent(
                {
                    "id": "intent_000001",
                    "chainId": "sepolia",
                    "direction": "USDC_TO_TGBP",
                    "recipientAddress": "0x1111111111111111111111111111111111111111",
                    "sourceAmount": "100",
                    "sourceRawAmount": "100000000",
                }
            )
        assert caught.value.details["swapIntentId"] == "intent_000001"

    def test_surfaces_the_last_5xx_once_retries_run_out(
        self, client: TgbpClient, transport: FakeTransport
    ) -> None:
        transport.replies.extend([reply(502, {})] * 4)
        with pytest.raises(TgbpKitError, match="failed with 502") as caught:
            client.mints.get("mint_1")
        assert len(transport.calls) == 4
        assert caught.value.details["attempts"] == 4

    def test_never_retries_a_call_that_is_not_safe_to_repeat(
        self, client: TgbpClient, transport: FakeTransport
    ) -> None:
        transport.replies.append(reply(503, {}))
        with pytest.raises(TgbpKitError, match="read the record first"):
            client.mints.simulate_payin("mint_1")
        assert len(transport.calls) == 1

    def test_backs_off_between_attempts(
        self, transport: FakeTransport, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        delays: list[float] = []
        monkeypatch.setattr(time, "sleep", delays.append)
        client = TgbpClient(api_key="k", environment="sandbox", transport=transport)
        transport.replies.extend([OSError(), OSError(), reply(200, {"data": fixture("mint")})])
        client.mints.get("mint_1")
        assert len(delays) == 2
        assert 0.25 <= delays[0] <= 0.5 and 0.5 <= delays[1] <= 1.0


class TestBrokenAnswers:
    def test_a_202_without_an_approval_id_keeps_the_key(
        self, client: TgbpClient, transport: FakeTransport
    ) -> None:
        transport.replies.append(reply(202, {"data": {}}))
        with pytest.raises(TgbpKitError, match="approval_request_id.*k1"):
            client.mints.create(MINT_BODY, idempotency_key="k1")

    def test_a_2xx_create_without_the_record(self, client: TgbpClient, transport: FakeTransport) -> None:
        transport.replies.append(reply(201, {"message": "ok"}))
        with pytest.raises(TgbpKitError, match="without the created record"):
            client.mints.create(MINT_BODY)

    def test_only_200_201_and_202_on_a_create(self, client: TgbpClient, transport: FakeTransport) -> None:
        transport.replies.append(reply(204, {"data": fixture("mint")}))
        with pytest.raises(TgbpKitError, match="recognised status"):
            client.mints.create(MINT_BODY)

    def test_a_non_json_2xx_is_an_error_keeping_the_text(
        self, client: TgbpClient, transport: FakeTransport
    ) -> None:
        transport.replies.append(reply(200, b"<html>proxy</html>"))
        with pytest.raises(TgbpKitError, match="not JSON") as caught:
            client.mints.get("mint_1")
        assert caught.value.details["body"] == "<html>proxy</html>"

    def test_caps_a_non_json_error_body(self, client: TgbpClient, transport: FakeTransport) -> None:
        transport.replies.append(reply(400, b"x" * 5000))
        with pytest.raises(TgbpKitError) as caught:
            client.mints.get("mint_1")
        assert caught.value.details["body"] == "x" * 2000

    def test_an_empty_2xx_is_an_error(self, client: TgbpClient, transport: FakeTransport) -> None:
        transport.replies.append(reply(200))
        with pytest.raises(TgbpKitError, match="empty"):
            client.mints.get("mint_1")

    def test_a_body_that_breaks_the_spec_is_an_error_naming_the_key(
        self, client: TgbpClient, transport: FakeTransport
    ) -> None:
        broken = fixture("mint")
        del broken["status"]
        transport.replies.append(reply(201, {"data": broken}))
        with pytest.raises(
            TgbpKitError, match="matching Mint.*retry only with the same idempotency key \\(k1\\)"
        ):
            client.mints.create(MINT_BODY, idempotency_key="k1")

    def test_takes_the_request_id_from_the_body_or_the_header(
        self, client: TgbpClient, transport: FakeTransport
    ) -> None:
        transport.replies.extend(
            [
                reply(
                    404, {"error": {"code": "not_found", "message": "no", "details": {"request_id": "r1"}}}
                ),
                reply(404, {}, {"x-request-id": "r2"}),
            ]
        )
        for expected in ("r1", "r2"):
            with pytest.raises(TgbpKitError) as caught:
                client.mints.get("mint_1")
            assert caught.value.details["requestId"] == expected

    def test_rejects_options_that_cannot_work(self) -> None:
        for options in ({"max_retries": -1}, {"base_delay": float("nan")}, {"timeout": 0}):
            with pytest.raises(ValueError):
                TgbpClient(api_key="k", environment="sandbox", **options)
        with pytest.raises(ValueError, match="api_key"):
            TgbpClient(api_key="", environment="sandbox")


class TestSwap:
    def test_reads_unwrap_data(self, swap: TgbpSwapClient, transport: FakeTransport) -> None:
        transport.replies.extend(
            [
                reply(200, {"data": fixture("quote")}),
                reply(200, {"data": fixture("limits")}),
                reply(200, {"data": fixture("deposit_session")}),
            ]
        )
        quote = swap.get_quote(GetQuoteQuery(usdcAmount="100", direction="USDC_TO_TGBP"))
        assert quote.gbpAmount == "74.5"
        assert (
            transport.calls[0].url
            == "https://swap-api.tgbp.io/api/quote?direction=USDC_TO_TGBP&usdcAmount=100"
        )
        assert swap.get_limits().dailyLimitUsd == "250000"
        assert swap.get_deposit_session().status == "active"

    def test_a_read_without_data_is_an_error(self, swap: TgbpSwapClient, transport: FakeTransport) -> None:
        transport.replies.append(reply(200, {}))
        with pytest.raises(TgbpKitError, match="without data"):
            swap.get_limits()

    def test_never_retries_a_cancel(self, swap: TgbpSwapClient, transport: FakeTransport) -> None:
        transport.replies.append(reply(500, {}))
        with pytest.raises(TgbpKitError):
            swap.cancel_swap_intent("intent_000001")
        assert len(transport.calls) == 1


class TestReviewHardening:
    def test_keeps_the_api_key_out_of_reprs(self, client: TgbpClient) -> None:
        config = client.mints._config
        assert "tgbp_sandbox_test" not in repr(config)
        request = HttpRequest("GET", "https://x.test", {"x-api-key": "tgbp_sandbox_test"}, None, 1.0)
        assert "tgbp_sandbox_test" not in repr(request)

    def test_rejects_an_api_key_with_whitespace_without_echoing_it(self) -> None:
        with pytest.raises(ValueError) as caught:
            TgbpClient(api_key="tgbp_sandbox_test\n", environment="sandbox")
        assert "tgbp_sandbox_test" not in str(caught.value)

    def test_does_not_echo_a_base_url_with_credentials(self) -> None:
        with pytest.raises(ValueError) as caught:
            TgbpClient(api_key="k", base_url="https://user:secret@api.tgbp.io")
        assert "secret" not in str(caught.value)

    def test_a_nan_in_a_2xx_is_not_json_and_keeps_the_key(
        self, client: TgbpClient, transport: FakeTransport
    ) -> None:
        transport.replies.append(reply(201, b'{"data": {"amount": {"value": NaN}}}'))
        with pytest.raises(TgbpKitError, match="not JSON.*same idempotency key \\(k1\\)"):
            client.mints.create(MINT_BODY, idempotency_key="k1")

    def test_a_status_newer_than_the_spec_still_reads(
        self, client: TgbpClient, transport: FakeTransport
    ) -> None:
        mint = fixture("mint")
        mint["status"] = "a_status_added_later"
        mint["amount"]["value"] = Decimal("1.005")
        transport.replies.append(reply(200, {"data": mint}))
        read = client.mints.get("mint_1").data
        assert read.status == "a_status_added_later"
        assert read.amount.value == Decimal("1.005")

    def test_names_the_field_a_broken_response_failed_at(
        self, client: TgbpClient, transport: FakeTransport
    ) -> None:
        broken = fixture("mint")
        del broken["created_at"]
        transport.replies.append(reply(200, {"data": broken}))
        with pytest.raises(TgbpKitError, match="failed at data.created_at"):
            client.mints.get("mint_1")

    def test_refuses_an_idempotency_key_in_the_body(self, client: TgbpClient) -> None:
        with pytest.raises(ValueError, match="idempotency_key="):
            client.mints.create({**MINT_BODY, "IdempotencyKey": "other"})

    def test_rejects_an_empty_swap_intent_id(self, swap: TgbpSwapClient) -> None:
        with pytest.raises(ValueError, match="swap intent id"):
            swap.create_swap_intent(
                {
                    "id": "",
                    "chainId": "sepolia",
                    "direction": "USDC_TO_TGBP",
                    "recipientAddress": "0x1111111111111111111111111111111111111111",
                    "sourceAmount": "100",
                    "sourceRawAmount": "100000000",
                }
            )

    def test_a_local_error_in_the_transport_is_not_retried_or_hidden(self, transport: FakeTransport) -> None:
        client = TgbpClient(api_key="k", environment="sandbox", transport=transport, base_delay=0)
        transport.replies.append(ValueError("a bug"))
        with pytest.raises(ValueError, match="a bug"):
            client.mints.get("mint_1")
        assert len(transport.calls) == 1
