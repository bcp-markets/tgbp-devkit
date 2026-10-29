#!/usr/bin/env bash
# Puts the x402 facilitator live on Base mainnet and settles a first 1p payment through it.
#
#   BASE_RPC_URL=<private Base RPC URL> ALERT_WEBHOOK_URL=<webhook URL> \
#     facilitator/go-live.sh <foundry keystore account>
#
# The keystore account needs a little Base ETH and at least 1p of tGBP. The script:
#   1. deploys the Worker and sets FACILITATOR_RPC_URL and ALERT_WEBHOOK_URL;
#   2. on the first run, makes the gas key inside a pipe straight into the Worker
#      secret, so no one sees it and it is never written down;
#   3. sets the bearer token: X402_FACILITATOR_TOKEN if set, else a fresh one it prints;
#   4. sends the gas key FUND_ETH (0.002 ETH) from the keystore when it holds under 0.001;
#   5. checks /supported, and that the gas key holds no tGBP;
#   6. runs the x402 demo: the keystore sends a fresh payer 1p of tGBP, and the payer
#      pays it back through the facilitator. The demo exits 1 if any check fails.
#
# Re-running keeps the gas key. Set FACILITATOR_URL to skip the deploy and use that URL.
set -euo pipefail

account=${1:?usage: BASE_RPC_URL=… ALERT_WEBHOOK_URL=… facilitator/go-live.sh <keystore account>}
: "${BASE_RPC_URL:?set BASE_RPC_URL to a private Base mainnet RPC URL}"
: "${ALERT_WEBHOOK_URL:?set ALERT_WEBHOOK_URL to the webhook that receives the low-gas alert}"
fund_eth=${FUND_ETH:-0.002}
root=$(cd "$(dirname "$0")/.." && pwd)
read -r -a wrangler <<<"${WRANGLER:-npx --yes wrangler@4.119.0}"
tgbp=0x27f6c8289550fCE67f6B50BeD1F519966aFE5287
# cast reads the RPC URL from the environment, so a URL with an API key stays out of `ps`.
export ETH_RPC_URL=$BASE_RPC_URL

secret() { "${wrangler[@]}" secret put "$1" --cwd "$root/facilitator" >/dev/null; }

if [[ $(cast chain-id) != 8453 ]]; then
  echo "BASE_RPC_URL is not on Base mainnet (chain id 8453)" >&2
  exit 1
fi

url=${FACILITATOR_URL:-}
if [[ -z $url ]]; then
  deployed=$("${wrangler[@]}" deploy --cwd "$root/facilitator")
  url=$(grep -oE 'https://[^ ]+\.workers\.dev' <<<"$deployed" | head -1)
  [[ -n $url ]] || { echo "could not read the Worker URL from wrangler deploy" >&2; exit 1; }
fi
echo "Facilitator: $url"

printf '%s' "$BASE_RPC_URL" | secret FACILITATOR_RPC_URL
printf '%s' "$ALERT_WEBHOOK_URL" | secret ALERT_WEBHOOK_URL

if ! "${wrangler[@]}" secret list --cwd "$root/facilitator" | grep -q FACILITATOR_PRIVATE_KEY; then
  cast wallet new --json | node -e '
    let s = ""
    process.stdin.on("data", (c) => (s += c)).on("end", () => process.stdout.write(JSON.parse(s)[0].private_key))
  ' | secret FACILITATOR_PRIVATE_KEY
  echo "Made a new gas key and stored it as the Worker secret FACILITATOR_PRIVATE_KEY"
fi

token=${X402_FACILITATOR_TOKEN:-}
if [[ -z $token ]]; then
  token=$(openssl rand -hex 32)
  echo "Bearer token for /verify and /settle (keep it; resource servers send it): $token"
fi
printf '%s' "$token" | secret FACILITATOR_AUTH_TOKEN

# A new secret reaches the Worker within seconds; wait for /supported to name the gas key.
supported=
for _ in $(seq 1 30); do
  supported=$(curl -fsS "$url/supported" 2>/dev/null) && break
  sleep 2
done
[[ -n $supported ]] || { echo "$url/supported did not answer" >&2; exit 1; }
echo "/supported: $supported"
gas=$(node -e 'const s = JSON.parse(process.argv[1]); process.stdout.write(s.signers["eip155:*"][0])' "$supported")
for want in '"scheme":"exact","network":"eip155:8453"' '"scheme":"upto","network":"eip155:8453"' 'eip2612GasSponsoring'; do
  grep -qF "$want" <<<"$supported" || { echo "/supported is missing $want" >&2; exit 1; }
done

if [[ $(cast balance "$gas") -lt $(cast to-wei 0.001) ]]; then
  echo "Sending the gas key $gas $fund_eth ETH from $account"
  cast send --account "$account" --value "${fund_eth}ether" "$gas" >/dev/null
fi
echo "Gas key $gas holds $(cast balance --ether "$gas") ETH"
gas_tgbp=$(env -u ETH_PASSWORD cast call "$tgbp" 'balanceOf(address)(uint256)' "$gas" | cut -d' ' -f1)
[[ $gas_tgbp == 0 ]] || { echo "the gas key holds tGBP ($gas_tgbp base units); it must hold none" >&2; exit 1; }
echo "Gas key holds 0 tGBP"

X402_FACILITATOR_TOKEN=$token BASE_RPC_URL=$BASE_RPC_URL \
  pnpm --dir "$root" --silent x402:demo --chain base --pence 1 --facilitator "$url" --fund-from "$account"
