import { AssetType, Chain, ClobClient, type ClobSigner } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import { loadTradingConfig } from '../config/trading';
import { getNextMarket } from '../bot/polymarket';

type CheckResult = { name: string; ok: boolean; detail: string };
type GeoblockStatus = { blocked?: boolean; country?: string; region?: string; ip?: string };

const GEOBLOCK_URL = 'https://polymarket.com/api/geoblock';
const HTTP_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (compatible; polymarket-bot/1.0)',
};

function createSigner(privateKey: string): ClobSigner {
  const normalized = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const wallet = new Wallet(normalized);
  return {
    _signTypedData: async (domain, types, value) => wallet.signTypedData(domain as any, types as any, value as any),
    getAddress: async () => wallet.address,
  };
}

function printResult(result: CheckResult): void {
  console.log(`[${result.ok ? 'PASS' : 'FAIL'}] ${result.name}: ${result.detail}`);
}

async function main(): Promise<void> {
  const config = loadTradingConfig();
  const checks: CheckResult[] = [];

  if (config.mode !== 'live') {
    throw new Error('Preflight requires TRADING_MODE=live');
  }
  if (!config.live.dryRun) {
    checks.push({
      name: 'LIVE_DRY_RUN',
      ok: false,
      detail: 'Expected LIVE_DRY_RUN=true for step-1 safe run',
    });
  } else {
    checks.push({ name: 'LIVE_DRY_RUN', ok: true, detail: 'enabled' });
  }

  const geoRes = await fetch(GEOBLOCK_URL, { headers: HTTP_HEADERS });
  if (!geoRes.ok) {
    checks.push({ name: 'Geoblock', ok: false, detail: `HTTP ${geoRes.status}` });
  } else {
    const geo = await geoRes.json() as GeoblockStatus;
    checks.push({
      name: 'Geoblock',
      ok: !geo.blocked,
      detail: `blocked=${geo.blocked ?? 'unknown'} country=${geo.country ?? 'n/a'} region=${geo.region ?? 'n/a'} ip=${geo.ip ?? 'n/a'}`,
    });
  }

  const signer = createSigner(config.live.privateKey!);
  const chainId = config.live.chainId === 137 ? Chain.POLYGON : Chain.AMOY;
  const l1 = new ClobClient(
    config.live.host,
    chainId,
    signer,
    undefined,
    config.live.signatureType,
    config.live.funderAddress
  );

  const creds = await l1.createOrDeriveApiKey();
  checks.push({
    name: 'CLOB L2 API creds',
    ok: Boolean(creds?.key && creds?.secret && creds?.passphrase),
    detail: 'createOrDeriveApiKey succeeded',
  });

  const clob = new ClobClient(
    config.live.host,
    chainId,
    signer,
    creds,
    config.live.signatureType,
    config.live.funderAddress,
    undefined,
    true
  );

  const closedOnly = await clob.getClosedOnlyMode();
  checks.push({
    name: 'Closed-only mode',
    ok: !closedOnly.closed_only,
    detail: `closed_only=${closedOnly.closed_only}`,
  });

  let collateral = await clob.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  let balance = parseNumberish(collateral.balance);
  let allowance = parseNumberish(collateral.allowance);

  // Some accounts have undefined/empty allowance until the first update call.
  // Try to initialize allowance once in preflight so operators can proceed.
  if (allowance === null) {
    try {
      await clob.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      collateral = await clob.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      balance = parseNumberish(collateral.balance);
      allowance = parseNumberish(collateral.allowance);
    } catch (err) {
      checks.push({
        name: 'Collateral allowance init',
        ok: false,
        detail: `updateBalanceAllowance failed: ${String(err)}`,
      });
    }
  }

  checks.push({
    name: 'Collateral balance',
    ok: balance !== null && balance >= config.tradeSizeUsdc,
    detail: `balance=${formatAmount(balance)} required>=${config.tradeSizeUsdc.toFixed(4)} (raw=${String(collateral.balance)})`,
  });
  checks.push({
    name: 'Collateral allowance',
    ok: allowance !== null && allowance >= config.tradeSizeUsdc,
    detail: `allowance=${formatAmount(allowance)} required>=${config.tradeSizeUsdc.toFixed(4)} (raw=${String(collateral.allowance)})`,
  });

  const market = await getNextMarket();
  if (!market) {
    checks.push({
      name: 'Next market',
      ok: false,
      detail: 'No active BTC 5M market found now',
    });
  } else {
    checks.push({
      name: 'Next market',
      ok: market.acceptingOrders,
      detail: `id=${market.id} acceptingOrders=${market.acceptingOrders} up=${market.priceUp} down=${market.priceDown}`,
    });
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Live Preflight | host=${config.live.host} chain=${chainId} tradeSize=$${config.tradeSizeUsdc.toFixed(2)}`);
  console.log('═══════════════════════════════════════════════════════════');
  checks.forEach(printResult);

  const failed = checks.filter((c) => !c.ok);
  console.log('═══════════════════════════════════════════════════════════');
  if (failed.length > 0) {
    console.log(`[Preflight] FAILED (${failed.length}/${checks.length})`);
    process.exit(1);
  }
  console.log(`[Preflight] OK (${checks.length}/${checks.length})`);
}

main().catch((err) => {
  console.error('[Preflight] Fatal:', err);
  process.exit(1);
});

function parseNumberish(v: unknown): number | null {
  const parsed = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatAmount(v: number | null): string {
  if (v === null) return 'NaN';
  return v.toFixed(4);
}
