"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const chain_catalogue_1 = require("../src/assets/chain-catalogue");
const prisma = new client_1.PrismaClient();
const ASSETS = [
    { code: 'btc', name: 'Bitcoin', order: 1, scale: 8, min: '0.00015', max: '2', floorUsd: 10 },
    { code: 'usdt', name: 'Tether', order: 2, scale: 6, min: '1', max: '1000000', floorUsd: 5 },
    { code: 'usdc', name: 'USD Coin', order: 3, scale: 6, min: '1', max: '1000000', floorUsd: 5 },
    { code: 'eth', name: 'Ethereum', order: 4, scale: 8, min: '0.001', max: '100', floorUsd: 10 },
    { code: 'bnb', name: 'BNB', order: 5, scale: 8, min: '0.0035', max: '1000', floorUsd: 10 },
    { code: 'xrp', name: 'XRP', order: 6, scale: 6, min: '1', max: '100000', floorUsd: 10 },
    { code: 'ltc', name: 'Litecoin', order: 7, scale: 8, min: '0.001', max: '1000', floorUsd: 10 },
    { code: 'sol', name: 'Solana', order: 8, scale: 8, min: '0.005', max: '100000', floorUsd: 10 },
    { code: 'bch', name: 'Bitcoin Cash', order: 9, scale: 8, floorUsd: 10 },
    { code: 'doge', name: 'Dogecoin', order: 10, scale: 8, floorUsd: 10 },
    { code: 'trx', name: 'Tron', order: 11, scale: 6, floorUsd: 10 },
    { code: 'pol', name: 'Polygon', order: 12, scale: 8, floorUsd: 10 },
    { code: 'link', name: 'Chainlink', order: 13, scale: 8, floorUsd: 10 },
    { code: 'ada', name: 'Cardano', order: 14, scale: 6, floorUsd: 10 },
    { code: 'sui', name: 'Sui', order: 15, scale: 8, floorUsd: 10 },
];
const TIER_LIMITS = [
    { tier: client_1.KycTier.TIER_0, canTrade: false, crypto: false, fiat: false, trade: 0, daily: 0, wd: 0 },
    { tier: client_1.KycTier.TIER_1, canTrade: true, crypto: true, fiat: true, trade: 200, daily: 500, wd: 500 },
    { tier: client_1.KycTier.TIER_2, canTrade: true, crypto: true, fiat: true, trade: 2000, daily: 5000, wd: 5000 },
    { tier: client_1.KycTier.TIER_3, canTrade: true, crypto: true, fiat: true, trade: 10000, daily: 50000, wd: 50000 },
];
async function main() {
    let networksSeeded = 0;
    for (const a of ASSETS) {
        await prisma.asset.upsert({
            where: { code: a.code },
            update: {
                name: a.name,
                sortOrder: a.order,
                displayScale: a.scale,
                transferMin: a.min ?? null,
                transferMax: a.max ?? null,
            },
            create: {
                code: a.code,
                name: a.name,
                isListed: true,
                sortOrder: a.order,
                displayScale: a.scale,
                transferMin: a.min ?? null,
                transferMax: a.max ?? null,
                transferStep: null,
                limitsSyncedAt: a.min ? new Date() : null,
            },
        });
        const hasConfig = await prisma.rateConfig.findFirst({ where: { assetCode: a.code } });
        if (!hasConfig) {
            await prisma.rateConfig.create({
                data: {
                    assetCode: a.code,
                    gateNgnPerUsd: '20',
                    swapFeeUsd: '2',
                    floorUsd: String(a.floorUsd),
                    maxTradeUsd: '2000',
                    quoteTtlSeconds: 12,
                    setBy: 'seed',
                    note: 'Initial gate — ₦20 per USD, added on buy and subtracted on sell',
                },
            });
        }
        await prisma.inventorySetting.upsert({
            where: { assetCode: a.code },
            update: {},
            create: {
                assetCode: a.code,
                target: '0',
                floorPct: '25',
                dipAlertPct: '5',
                fallbackSwapEnabled: true,
            },
        });
        for (const net of (0, chain_catalogue_1.seedNetworksFor)(a.code)) {
            await prisma.assetNetwork.upsert({
                where: { assetCode_networkId: { assetCode: a.code, networkId: net.id } },
                update: {},
                create: {
                    assetCode: a.code,
                    networkId: net.id,
                    label: net.label,
                    depositsEnabled: net.deposits,
                    withdrawsEnabled: net.withdraws,
                    isDefault: net.isDefault ?? false,
                    isListed: true,
                    confirmations: net.confirmations ?? 1,
                    requiresTag: net.requiresTag ?? (0, chain_catalogue_1.requiresTag)(a.code, net.id),
                },
            });
            networksSeeded++;
        }
    }
    await prisma.asset.upsert({
        where: { code: 'ngn' },
        update: {},
        create: {
            code: 'ngn',
            name: 'Nigerian Naira',
            isListed: true,
            isFiat: true,
            sortOrder: 0,
            displayScale: 2,
            transferMin: '1',
            transferMax: '500000000',
        },
    });
    for (const t of TIER_LIMITS) {
        await prisma.kycTierLimit.upsert({
            where: { tier: t.tier },
            update: {},
            create: {
                tier: t.tier,
                canTrade: t.canTrade,
                canWithdrawCrypto: t.crypto,
                canWithdrawFiat: t.fiat,
                maxTradeUsd: String(t.trade),
                maxDailyTradeUsd: String(t.daily),
                maxDailyWithdrawUsd: String(t.wd),
            },
        });
    }
    for (const [key, value] of Object.entries({
        trading_enabled: true,
        deposits_enabled: true,
        withdrawals_enabled: true,
        paused_assets: [],
    })) {
        await prisma.systemFlag.upsert({
            where: { key },
            update: {},
            create: { key, value: value, updatedBy: 'seed' },
        });
    }
    const withoutChains = ASSETS.filter((a) => (0, chain_catalogue_1.seedNetworksFor)(a.code).length === 0).map((a) => a.code);
    console.log(`Seeded ${ASSETS.length + 1} assets, ${networksSeeded} chains, ` +
        `${TIER_LIMITS.length} tiers, 4 flags`);
    if (withoutChains.length > 0) {
        console.warn(`  no chains seeded for: ${withoutChains.join(', ')} — deposits will be unavailable until a sync runs`);
    }
    console.log('  chains are PROVISIONAL (syncedAt=null). Run POST /admin/assets/sync-networks against the live key to confirm them.');
}
main()
    .catch((e) => {
    console.error(e);
    process.exit(1);
})
    .finally(() => prisma.$disconnect());
//# sourceMappingURL=seed.js.map