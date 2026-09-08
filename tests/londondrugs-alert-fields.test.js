/**
 * London Drugs alerts must carry the two facts that make them actionable.
 *
 * Both were already being computed and then silently dropped, which is the worst shape for a
 * defect: the work was paid for and the reader never saw it.
 *
 * 1. THE EXACT STOCK COUNT. The adapter parsed `inventory.onlineStockLevel` into a field it
 *    called `stockLevel`. The embed reads `product._stockQty || product.stockCount`. Nothing
 *    anywhere read `stockLevel`, so every London Drugs alert rendered "Stock: 1+" while the
 *    real number — 26 on the Mewtwo battle deck the day this was found — sat in a payload we
 *    had already spent a ScraperAPI credit to fetch.
 *
 * 2. PICKUP-ONLY. Every London Drugs TCG item is InStorePickup with no DirectShip. The
 *    adapter computes `pickupOnly` and its own comment explains the stakes — "saying otherwise
 *    in an embed would be a wrong field, which is worse than a missing one" — but no embed
 *    ever displayed it. Saying nothing is not neutral here: a reader seeing an in-stock alert
 *    with no fulfilment note will reasonably assume it ships, and it does not.
 *
 * The competitor's equivalent alert carries a store address we cannot obtain: London Drugs
 * runs on Kibo (tenant 28945) and its locationinventory endpoint answers 401 "Application
 * access token required". These two fields are the part we CAN state truthfully.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { buildAlertEmbed } = require('../src/discord/embeds');
const { EVENT_TYPES } = require('../src/core/events');
const LondonDrugsAdapter = require('../src/adapters/londondrugs');

function fieldsOf(embed) {
  const out = {};
  for (const f of (embed.data && embed.data.fields) || []) out[f.name] = f.value;
  return out;
}

function alertFor(product) {
  const { embed } = buildAlertEmbed({
    type: EVENT_TYPES.RESTOCK,
    product: {
      sku: 'L3293797',
      name: "Pokemon TCG: Team Rocket's Mewtwo ex League Battle Deck",
      price: 54.99,
      currency: 'CAD',
      url: 'https://www.londondrugs.com/products/x/p/L3293797',
      retailerId: 'londondrugs',
      retailer: 'London Drugs',
      inStock: true,
      ...product,
    },
  }, 'paid');
  return fieldsOf(embed);
}

describe('london drugs alert fields', () => {
  test('the exact stock count reaches the embed', () => {
    const f = alertFor({ stockCount: 26, pickupOnly: true });
    assert.strictEqual(f.Stock, '26',
      'the embed fell back to "1+" while the adapter held the real number — that is the ' +
      'stockLevel/stockCount name mismatch coming back');
  });

  test('it still falls back to 1+ when no count is available', () => {
    const f = alertFor({ stockCount: null, pickupOnly: true });
    assert.strictEqual(f.Stock, '1+');
  });

  test('a pickup-only product says so', () => {
    const f = alertFor({ stockCount: 26, pickupOnly: true });
    assert.ok(f.Fulfilment, 'no fulfilment field — the reader cannot tell this will not ship');
    assert.match(f.Fulfilment, /pickup only/i);
  });

  test('a shippable product says nothing, rather than adding noise', () => {
    const f = alertFor({ stockCount: 5, pickupOnly: false, shipsToHome: true });
    assert.strictEqual(f.Fulfilment, undefined,
      '"ships to home" on every alert from every retailer is noise, not information');
  });

  test('a retailer that reports no fulfilment data stays silent rather than guessing', () => {
    const f = alertFor({ stockCount: 5 });
    assert.strictEqual(f.Fulfilment, undefined,
      'absent data must not be rendered as a claim in either direction — a wrong field is ' +
      'worse than a missing one');
  });

  // The defect was a NAME mismatch between adapter and embed, so a test that hands the embed
  // a hand-written product cannot catch it. This one runs the real parser and then the real
  // embed, which is the only path that would have failed before the fix.
  test('end to end: the adapter emits the field the embed actually reads', () => {
    const payload = [
      ['aa01', ['InStorePickup']],
      ['aa02', { price: 54.99, salePrice: null, listPrice: 54.99 }],
      ['aa03', {
        productCode: 'L3293797',
        supportedFulfilmentTypes: '$aa01',
        isAvailable: true,
        inventory: { onlineStockLevel: 26 },
        productName: "Pokemon TCG: Team Rocket's Mewtwo ex League Battle Deck",
        price: '$aa02',
        maxOrderableQuantity: 2,
      }],
    ].map(([id, obj]) => `${id}:${JSON.stringify(obj)}`).join('\n');
    const html = `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>`;

    const adapter = new LondonDrugsAdapter({
      id: 'londondrugs', name: 'London Drugs', url: 'https://www.londondrugs.com',
      intervalMs: 30000, proxyTier: 'residential',
    });
    const [product] = adapter._toProducts(html);
    assert.ok(product, 'the fixture should parse to one product');
    assert.strictEqual(product.stockCount, 26,
      'the adapter emitted the count under a name the embed does not read — that is the ' +
      'original bug, where 26 units rendered as "Stock: 1+"');
    assert.strictEqual(product.pickupOnly, true, 'InStorePickup with no DirectShip is pickup-only');

    const { embed } = buildAlertEmbed({ type: EVENT_TYPES.RESTOCK, product: { ...product, retailerId: 'londondrugs', retailer: 'London Drugs' } }, 'paid');
    const f = fieldsOf(embed);
    assert.strictEqual(f.Stock, '26');
    assert.match(f.Fulfilment, /pickup only/i);
  });

  test('the store field names where the units actually are', () => {
    const f = alertFor({
      stockCount: 26, pickupOnly: true,
      _stores: [
        { code:'002', name:'Granville & Georgia', stockAvailable:1, distanceM:946,
          address1:'710 Granville Street', city:'Vancouver', province:'British Columbia', postal:'V6Z 1E4' },
        { code:'090', name:'Richmond Centre', stockAvailable:4, distanceM:9200,
          address1:'6551 No 3 Road', city:'Richmond', province:'British Columbia', postal:'V6Y 2B6' },
      ],
    });
    assert.ok(f.Store, 'no Store field — on a pickup-only retailer the address is the alert');
    assert.match(f.Store, /Granville & Georgia/);
    assert.match(f.Store, /1 in stock/);
    assert.match(f.Store, /710 Granville Street, Vancouver, British Columbia V6Z 1E4/);
    assert.match(f.Store, /\+1 other store in stock/);
  });

  test('retailers with no store data show no Store field at all', () => {
    const f = alertFor({ stockCount: 26, pickupOnly: true });
    assert.strictEqual(f.Store, undefined,
      'an empty heading is worse than no heading; only London Drugs has this data');
  });

  test('store data that has no stock anywhere renders nothing, not "unavailable"', () => {
    const f = alertFor({ stockCount: 26, pickupOnly: true,
      _stores: [{ code:'082', name:'Olympic Village', stockAvailable:0, distanceM:1480,
        address1:'1622 Salt Street', city:'Vancouver', province:'British Columbia', postal:'V5Y 0E4' }] });
    assert.strictEqual(f.Store, undefined,
      'the lookup may simply have missed it — stating absence as fact would be a wrong field');
  });
});

describe('london drugs product image', () => {
  const LondonDrugsAdapter2 = require('../src/adapters/londondrugs');

  test('every product carries its Kibo CDN image', () => {
    // The storefront builds these from kiboImagesFilePath in its own bundle; verified 200
    // image/jpeg on five SKUs. The -S/-M/-L variants the bundle also references all 404, so
    // only the bare product code resolves — hence no size suffix here.
    const payload = [
      ['bb01', ['InStorePickup']],
      ['bb02', { price: 9.49, salePrice: null, listPrice: 9.49 }],
      ['bb03', { productCode: 'L3408413', supportedFulfilmentTypes: '$bb01', isAvailable: true,
        inventory: { onlineStockLevel: 318 },
        productName: 'Pokemon TCG: Mega Evolution Pitch Black Booster Blister',
        price: '$bb02' }],
    ].map(([id, o]) => `${id}:${JSON.stringify(o)}`).join('\n');
    const html = `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>`;

    const a = new LondonDrugsAdapter2({ id: 'londondrugs', name: 'London Drugs',
      url: 'https://www.londondrugs.com', intervalMs: 30000, proxyTier: 'residential' });
    const [product] = a._toProducts(html);
    assert.strictEqual(product.image,
      'https://cdn-tp2.mozu.com/28945-m4/cms/files/L3408413.jpg',
      'no image means the embed renders without a thumbnail, unlike every other retailer');
  });
});
