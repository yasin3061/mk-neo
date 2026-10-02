/*
 * MK.config - master data and every tunable parameter of the demo model, in one declarative place.
 * Sources: docs/RESEARCH.md (binding parameters), docs/DATA-FEASIBILITY.md (channel capabilities).
 * Nothing here is computed from outputs: tune a parameter, re-run the engine, read the result.
 * Values marked (A) are assumptions where the public record is silent.
 * Loads in the browser (classic script) and in Node. No DOM, no clock, no randomness.
 */
(function (root) {
  'use strict';

  var MK = root.MK || (root.MK = {});
  var cal = MK.calendar;

  /* Month keys covered by the dataset; every monthly price series below is aligned to this list. */
  var MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];

  var config = {
    today: cal.today,
    dataStart: cal.dataStart,
    dataEnd: cal.dataEnd,
    fyLabel: cal.fyLabel,
    months: MONTHS,
    company: { name: 'Miya Kebabs', legalNote: 'Demo dataset - all figures are illustrative' }
  };

  /* ------------------------------------------------------------------ units */
  /* Order is fixed (it drives cube indices and the outlet colours). hours are business-day decimals: 27.75 = 3:45 am. */

  config.outlets = [
    { id: 'bandra', name: 'Bandra', short: 'Bandra', code: 'BAN', type: 'outlet', city: 'Mumbai', area: 'Pali Hill', region: 'Mumbai region',
      sqft: 450, seats: 18, openedOn: '2021-12-10', hours: { open: 17, close: 27.75 }, electricityZone: 'mumbai_licensee',
      colourVar: '--ot-1', managerUserId: 'u_om_bandra' },
    { id: 'andheri', name: 'Andheri', short: 'Andheri', code: 'AND', type: 'outlet', city: 'Mumbai', area: 'Oshiwara, Andheri West', region: 'Mumbai region',
      sqft: 650, seats: 28, openedOn: '2024-03-15', hours: { open: 12.75, close: 27 }, electricityZone: 'mumbai_licensee',
      colourVar: '--ot-2', managerUserId: null },
    { id: 'fort', name: 'Fort', short: 'Fort', code: 'FRT', type: 'outlet', city: 'Mumbai', area: 'Fort', region: 'Mumbai region',
      sqft: 500, seats: 24, openedOn: '2024-08-20', hours: { open: 12.75, close: 27.5 }, electricityZone: 'mumbai_licensee',
      colourVar: '--ot-3', managerUserId: null },
    { id: 'kalyan', name: 'Kalyan', short: 'Kalyan', code: 'KYN', type: 'outlet', city: 'Kalyan', area: 'Kalyan West', region: 'Mumbai region',
      sqft: 500, seats: 26, openedOn: '2023-06-05', hours: { open: 13, close: 23.75 }, electricityZone: 'msedcl',
      colourVar: '--ot-4', managerUserId: null },
    { id: 'koregaon', name: 'Koregaon Park', short: 'Koregaon Pk', code: 'KPK', type: 'outlet', city: 'Pune', area: 'Koregaon Park', region: 'Pune',
      sqft: 400, seats: 8, openedOn: '2025-07-12', hours: { open: 12.5, close: 26 }, electricityZone: 'msedcl',
      colourVar: '--ot-5', managerUserId: null },
    { id: 'factory', name: 'Factory (Central Kitchen)', short: 'Factory', code: 'FAC', type: 'factory', city: 'Mumbai', area: null, region: 'Mumbai region',
      sqft: 2500, seats: 0, openedOn: '2023-04-01', hours: null, electricityZone: 'mumbai_licensee',
      colourVar: '--ot-factory', managerUserId: 'u_fm' },
    { id: 'ho', name: 'Head office', short: 'Head office', code: 'HO', type: 'ho', city: 'Mumbai', area: null, region: 'Mumbai region',
      sqft: 0, seats: 0, openedOn: null, hours: null, electricityZone: null,
      colourVar: '--series-muted', managerUserId: null }
  ];

  config.regions = [
    { id: 'mumbai', label: 'Mumbai region', outletIds: ['bandra', 'andheri', 'fort', 'kalyan'] },
    { id: 'pune', label: 'Pune', outletIds: ['koregaon'] }
  ];

  config.users = MK.session ? MK.session.users : [];

  /* --------------------------------------------------- channels and streams */

  /*
   * Source tags of a channel (DATA-FEASIBILITY.md section 1). salesSource: where its ORDER data comes from - always the POS,
   * because aggregator orders are relayed into Petpooja. statementSource: the weekly upload that carries its fees and payouts
   * (null for the POS). 'source' is kept for callers that read it as the statement source of an aggregator; never tag a sales
   * figure with it - sales selectors return their own result.source ('petpooja').
   */
  config.channels = [
    { id: 'petpooja', label: 'Petpooja POS', short: 'In-store', kind: 'pos', colourVar: '--ch-petpooja', salesSource: 'petpooja', statementSource: null, source: 'petpooja' },
    { id: 'swiggy', label: 'Swiggy', short: 'Swiggy', kind: 'aggregator', colourVar: '--ch-swiggy', salesSource: 'petpooja', statementSource: 'swiggy_annexure', source: 'swiggy_annexure' },
    { id: 'zomato', label: 'Zomato', short: 'Zomato', kind: 'aggregator', colourVar: '--ch-zomato', salesSource: 'petpooja', statementSource: 'zomato_settlement', source: 'zomato_settlement' }
  ];

  config.mediums = [
    { id: 'dinein', label: 'Dine-in', colourVar: '--md-dinein' },
    { id: 'takeaway', label: 'Takeaway', colourVar: '--md-takeaway' },
    { id: 'delivery', label: 'Delivery', colourVar: '--md-delivery' }
  ];

  /* The only valid channel x medium pairs. Order is fixed (cube index). Colours reuse entity tokens. */
  config.streams = [
    { id: 'pp_dinein', label: 'In-store dine-in', channelId: 'petpooja', mediumId: 'dinein', colourVar: '--md-dinein' },
    { id: 'pp_takeaway', label: 'In-store takeaway', channelId: 'petpooja', mediumId: 'takeaway', colourVar: '--md-takeaway' },
    { id: 'sw_delivery', label: 'Swiggy delivery', channelId: 'swiggy', mediumId: 'delivery', colourVar: '--ch-swiggy' },
    { id: 'zo_delivery', label: 'Zomato delivery', channelId: 'zomato', mediumId: 'delivery', colourVar: '--ch-zomato' }
  ];

  /* ------------------------------------------------------- business day */
  /* Business day = 12:00 noon to 04:00 next morning. Hour buckets 12..27 (24 = midnight, 27 = 3 am). */

  config.businessDay = { startHour: 12, endHour: 28 };

  config.slots = [
    { id: 'lunch', label: 'Lunch', fromHour: 12, toHour: 16, range: '12 pm - 4 pm' },
    { id: 'evening', label: 'Evening', fromHour: 16, toHour: 19, range: '4 pm - 7 pm' },
    { id: 'dinner', label: 'Dinner', fromHour: 19, toHour: 23, range: '7 pm - 11 pm' },
    { id: 'latenight', label: 'Late night', fromHour: 23, toHour: 28, range: '11 pm - 4 am' }
  ];

  config.hours = (function () {
    var out = [];
    for (var h = 12; h <= 27; h++) {
      var clock = h % 24, twelve = clock % 12 === 0 ? 12 : clock % 12;
      var slot = h < 16 ? 'lunch' : h < 19 ? 'evening' : h < 23 ? 'dinner' : 'latenight';
      out.push({ hour: h, label: twelve + (clock < 12 ? ' am' : ' pm'), slotId: slot, nextCalendarDay: h >= 24 });
    }
    return out;
  })();

  /* ------------------------------------------------------------------ menu */
  /*
   * Twelve real menu items (RESEARCH.md section 3). posPrice is the in-store card on dataStart;
   * priceChanges move a list over time. aggPrices is the aggregator menu price per outlet (the
   * same list is used on Swiggy and Zomato (A)); Kalyan has its own list; a missing outlet key
   * means "not sold there". Recipes: factory SKUs in grams at transfer price, local-purchase
   * items in their own unit (g, ml, pc), packaging per dish for delivery and takeaway.
   */

  function agg(std, kalyan) { return { bandra: std, andheri: std, fort: std, kalyan: kalyan, koregaon: std }; }
  function fp(sku, g) { return { sku: sku, g: g }; }
  function li(itemId, qty) { return { itemId: itemId, qty: qty }; }

  var PACK_SHAWARMA = { delivery: [li('PK_WRAP', 1), li('PK_DIP', 1)], takeaway: [li('PK_WRAP', 1)] };
  var PACK_KEBAB = { delivery: [li('PK_BOX_M', 1), li('PK_DIP', 1)], takeaway: [li('PK_BOX_S', 1)] };
  var KEBAB_SIDES = [li('L_ONION', 80), li('L_SALADVEG', 70), li('L_CURD', 50), li('L_BUTTER', 15), li('L_SPICE', 8), li('L_OIL', 15), li('L_SAUCE', 15)];

  config.categories = [
    { id: 'shawarma', label: 'Shawarma' }, { id: 'signature_kebabs', label: 'Signature kebabs' },
    { id: 'classic_kebabs', label: 'Classic kebabs' }, { id: 'seekh_kebabs', label: 'Seekh kebabs' },
    { id: 'gravy', label: 'Gravy' }, { id: 'appetisers', label: 'Appetisers' },
    { id: 'breads', label: 'Breads' }, { id: 'rolls', label: 'Rolls' }
  ];

  config.dishes = [
    { id: 'angara_shawarma', name: 'Angara Chicken Shawarma', short: 'Angara Shawarma', category: 'shawarma', veg: false,
      posPrice: 185, aggPrices: agg(309, 275), priceChanges: [],
      recipe: { factory: [fp('FP02', 135), fp('FP08', 22)],
        local: [li('L_KHUBZ', 1), li('L_FRIES', 60), li('L_SALADVEG', 50), li('L_PICKLE', 25), li('L_SAUCE', 20), li('L_OIL', 18)], packaging: PACK_SHAWARMA } },
    { id: 'bc_shawarma', name: 'Butter Chicken Shawarma', short: 'BC Shawarma', category: 'shawarma', veg: false,
      posPrice: 220, aggPrices: agg(340, 305), priceChanges: [],
      recipe: { factory: [fp('FP02', 135), fp('FP05', 70), fp('FP08', 15)],
        local: [li('L_KHUBZ', 1), li('L_FRIES', 60), li('L_SALADVEG', 40), li('L_BUTTER', 10), li('L_CREAM', 15), li('L_SAUCE', 12), li('L_OIL', 18)], packaging: PACK_SHAWARMA } },
    { id: 'paneer_shawarma', name: 'Angara Paneer Shawarma', short: 'Paneer Shawarma', category: 'shawarma', veg: true,
      posPrice: 185, aggPrices: agg(309, 275), priceChanges: [],
      recipe: { factory: [fp('FP06', 115), fp('FP08', 22)],
        local: [li('L_KHUBZ', 1), li('L_FRIES', 60), li('L_SALADVEG', 50), li('L_PICKLE', 25), li('L_SAUCE', 20), li('L_OIL', 18)], packaging: PACK_SHAWARMA } },
    { id: 'changezi_tikka', name: 'Chicken Changezi Tikka', short: 'Changezi Tikka', category: 'signature_kebabs', veg: false,
      posPrice: 390, aggPrices: agg(540, 510), priceChanges: [], note: 'Served with masala naan',
      recipe: { factory: [fp('FP01', 270), fp('FP05', 70), fp('FP09', 130)],
        local: KEBAB_SIDES.concat([li('L_CREAM', 15)]), packaging: PACK_KEBAB } },
    { id: 'kashmiri_tikka', name: 'Chicken Kashmiri Tikka', short: 'Kashmiri Tikka', category: 'signature_kebabs', veg: false,
      posPrice: 390, aggPrices: agg(540, 510), priceChanges: [],
      recipe: { factory: [fp('FP01', 280)],
        local: KEBAB_SIDES.concat([li('L_CASHEW', 15), li('L_CREAM', 25)]), packaging: PACK_KEBAB } },
    { id: 'angara_tikka', name: 'Chicken Angara Tikka', short: 'Angara Tikka', category: 'classic_kebabs', veg: false,
      posPrice: 290, aggPrices: agg(465, 390), priceChanges: [],
      recipe: { factory: [fp('FP01', 245)], local: KEBAB_SIDES, packaging: PACK_KEBAB } },
    { id: 'chicken_seekh', name: 'Chicken Seekh Kebabs', short: 'Chicken Seekh', category: 'seekh_kebabs', veg: false,
      posPrice: 280, aggPrices: agg(410, 410), priceChanges: [],
      recipe: { factory: [fp('FP03', 245)], local: KEBAB_SIDES, packaging: PACK_KEBAB } },
    { id: 'mutton_seekh', name: 'Mutton Seekh Kebabs', short: 'Mutton Seekh', category: 'seekh_kebabs', veg: false,
      posPrice: 450, aggPrices: agg(560, 595),
      /* Seeded markup anomaly: the POS card moved with the mutton cost, the aggregator lists did not. */
      priceChanges: [{ date: '2026-08-01', list: 'pos', price: 480, note: 'Mutton cost increase' }],
      recipe: { factory: [fp('FP04', 225)], local: KEBAB_SIDES, packaging: PACK_KEBAB } },
    { id: 'butter_chicken', name: 'Butter Chicken', short: 'Butter Chicken', category: 'gravy', veg: false,
      posPrice: 390, aggPrices: agg(599, 550), priceChanges: [],
      recipe: { factory: [fp('FP01', 185), fp('FP05', 240)],
        local: [li('L_BUTTER', 22), li('L_CREAM', 45), li('L_SPICE', 6), li('L_SALADVEG', 25), li('L_ONION', 40)],
        packaging: { delivery: [li('PK_TUB', 1)], takeaway: [li('PK_TUB', 1)] } } },
    { id: 'zaatar_hummus', name: "Za'atar Naan with Hummus", short: "Za'atar Hummus", category: 'appetisers', veg: true,
      posPrice: 420, aggPrices: agg(540, 545), priceChanges: [],
      recipe: { factory: [fp('FP07', 180), fp('FP09', 220)],
        local: [li('L_ZAATAR', 25), li('L_SALADVEG', 70), li('L_PICKLE', 30), li('L_BUTTER', 8)],
        packaging: { delivery: [li('PK_TUB', 1), li('PK_NAAN', 1)], takeaway: [li('PK_TUB', 1), li('PK_NAAN', 1)] } } },
    { id: 'butter_naan', name: 'Butter Naan', short: 'Butter Naan', category: 'breads', veg: true, isAttach: true,
      posPrice: 65, aggPrices: agg(70, 85), priceChanges: [],
      recipe: { factory: [fp('FP09', 130)], local: [li('L_BUTTER', 12)],
        packaging: { delivery: [li('PK_NAAN', 1)], takeaway: [li('PK_NAAN', 1)] } } },
    { id: 'bc_roll', name: 'Butter Chicken Roll', short: 'BC Roll', category: 'rolls', veg: false,
      posPrice: 240, aggPrices: { koregaon: 340 }, availableAt: ['koregaon'], priceChanges: [],
      recipe: { factory: [fp('FP02', 130), fp('FP05', 50)],
        local: [li('L_RUMALI', 1), li('L_ONION', 40), li('L_SALADVEG', 35), li('L_BUTTER', 8), li('L_SAUCE', 15), li('L_OIL', 12)],
        packaging: { delivery: [li('PK_WRAP', 1)], takeaway: [li('PK_WRAP', 1)] } } }
  ];

  /* Packaging added once per order, on top of the per-dish packaging in the recipes. */
  config.orderPackaging = { delivery: [li('PK_BAG_D', 1)], takeaway: [li('PK_BAG_T', 1)], dinein: [] };

  /* Packaging charge billed to the customer (Rs per order, RESEARCH.md section 3: Rs 10-25 (A)). */
  config.packagingCharge = {
    dinein: { base: 0, perExtraLine: 0, max: 0 },
    takeaway: { base: 10, perExtraLine: 5, max: 15 },
    delivery: { base: 10, perExtraLine: 5, max: 25 }
  };

  /* ----------------------------------------------------------------- items */
  /* prices: one value per month of config.months (Apr..Sep 2026), Rs per unit. */

  function flat(v) { return [v, v, v, v, v, v]; }

  config.items = {
    /* Raw materials bought by the factory. stdPrice is the standard used to set the SKU standard cost. */
    rawMaterials: [
      { id: 'RM_CHICKEN', name: 'Boneless chicken thigh', unit: 'kg', stdPrice: 270, prices: [268, 282, 290, 284, 262, 255], vendorCategory: 'poultry', storage: 'fresh' },
      { id: 'RM_MUTTON', name: 'Mutton mince', unit: 'kg', stdPrice: 700, prices: [748, 755, 765, 772, 780, 785], vendorCategory: 'mutton', storage: 'fresh' },
      { id: 'RM_PANEER', name: 'Paneer', unit: 'kg', stdPrice: 328, prices: [320, 324, 328, 332, 335, 330], vendorCategory: 'dairy', storage: 'fresh' },
      { id: 'RM_ONION', name: 'Onion', unit: 'kg', stdPrice: 30, prices: [25, 24, 28, 38, 52, 55], vendorCategory: 'vegetables', storage: 'fresh' },
      { id: 'RM_TOMATO', name: 'Tomato', unit: 'kg', stdPrice: 28, prices: [20, 22, 28, 35, 32, 26], vendorCategory: 'vegetables', storage: 'fresh' },
      { id: 'RM_GARLIC', name: 'Garlic, peeled', unit: 'kg', stdPrice: 160, prices: [150, 155, 160, 168, 172, 170], vendorCategory: 'vegetables', storage: 'fresh' },
      { id: 'RM_LEMON', name: 'Lemon juice and herbs', unit: 'kg', stdPrice: 120, prices: [130, 125, 115, 112, 118, 120], vendorCategory: 'vegetables', storage: 'fresh' },
      { id: 'RM_OIL', name: 'Refined oil', unit: 'l', stdPrice: 175, prices: [172, 175, 178, 182, 185, 183], vendorCategory: 'oil', storage: 'dry' },
      { id: 'RM_CURD', name: 'Curd', unit: 'kg', stdPrice: 80, prices: [78, 79, 80, 82, 84, 83], vendorCategory: 'dairy', storage: 'fresh' },
      { id: 'RM_CREAM', name: 'Fresh cream', unit: 'l', stdPrice: 245, prices: [240, 242, 244, 246, 249, 247], vendorCategory: 'dairy', storage: 'fresh' },
      { id: 'RM_BUTTER', name: 'Butter', unit: 'kg', stdPrice: 600, prices: [570, 585, 600, 615, 630, 622], vendorCategory: 'dairy', storage: 'frozen' },
      { id: 'RM_MAIDA', name: 'Maida (refined flour)', unit: 'kg', stdPrice: 41, prices: [40, 40, 41, 42, 43, 43], vendorCategory: 'dry_goods', storage: 'dry' },
      { id: 'RM_CHICKPEA', name: 'Chickpeas', unit: 'kg', stdPrice: 110, prices: [105, 108, 110, 114, 118, 116], vendorCategory: 'dry_goods', storage: 'dry' },
      { id: 'RM_CASHEW', name: 'Cashew (broken)', unit: 'kg', stdPrice: 670, prices: [640, 655, 670, 685, 700, 690], vendorCategory: 'dry_goods', storage: 'dry' },
      { id: 'RM_TAHINI', name: 'Tahini', unit: 'kg', stdPrice: 520, prices: [515, 518, 520, 524, 528, 526], vendorCategory: 'dry_goods', storage: 'dry' },
      { id: 'RM_OLIVE_OIL', name: 'Olive oil blend', unit: 'l', stdPrice: 650, prices: [640, 645, 650, 655, 662, 660], vendorCategory: 'oil', storage: 'dry' },
      { id: 'RM_SPICE', name: 'Spice and marinade mix', unit: 'kg', stdPrice: 420, prices: [415, 418, 420, 424, 428, 426], vendorCategory: 'dry_goods', storage: 'dry' }
    ],

    /*
     * Factory products. stdRmCost and stdYield are RESEARCH.md section 7. Yield is output per kg of
     * the primary input (first BOM line) unless yieldBasis is 'total_input' (cooked-down or emulsified products). bom = standard inputs per kg of OUTPUT; at stdPrice it
     * reproduces stdRmCost. transferPrice = stdRmCost + conversionPerKg (standard-cost transfer).
     */
    factoryProducts: [
      { id: 'FP01', name: 'Marinated chicken tikka, red', unit: 'kg', stdRmCost: 275, stdYield: 1.20, shelfLifeHours: 72, usedIn: 'Tikkas, butter chicken',
        bom: [['RM_CHICKEN', 0.8333], ['RM_CURD', 0.10], ['RM_OIL', 0.03], ['RM_SPICE', 0.0875]] },
      { id: 'FP02', name: 'Shawarma chicken, marinated', unit: 'kg', stdRmCost: 262, stdYield: 1.15, shelfLifeHours: 72, usedIn: 'Shawarmas, roll',
        bom: [['RM_CHICKEN', 0.8696], ['RM_CURD', 0.05], ['RM_OIL', 0.02], ['RM_SPICE', 0.0469]] },
      { id: 'FP03', name: 'Chicken seekh mix', unit: 'kg', stdRmCost: 258, stdYield: 1.06, shelfLifeHours: 48, usedIn: 'Chicken seekh',
        bom: [['RM_CHICKEN', 0.9434], ['RM_ONION', 0.03], ['RM_SPICE', 0.0057]] },
      { id: 'FP04', name: 'Mutton seekh mix', unit: 'kg', stdRmCost: 660, stdYield: 1.08, shelfLifeHours: 48, usedIn: 'Mutton seekh',
        bom: [['RM_MUTTON', 0.9259], ['RM_ONION', 0.03], ['RM_SPICE', 0.0262]] },
      { id: 'FP05', name: 'Makhani gravy base', unit: 'kg', stdRmCost: 175, stdYield: 0.88, shelfLifeHours: 96, usedIn: 'Butter chicken, BC shawarma, roll',
        bom: [['RM_TOMATO', 0.70], ['RM_ONION', 0.10], ['RM_BUTTER', 0.06], ['RM_CREAM', 0.10], ['RM_CASHEW', 0.10], ['RM_OIL', 0.03], ['RM_SPICE', 0.0468]], yieldBasis: 'total_input' },
      { id: 'FP06', name: 'Marinated paneer', unit: 'kg', stdRmCost: 330, stdYield: 1.18, shelfLifeHours: 72, usedIn: 'Paneer shawarma',
        bom: [['RM_PANEER', 0.8475], ['RM_CURD', 0.08], ['RM_OIL', 0.02], ['RM_SPICE', 0.1002]] },
      { id: 'FP07', name: 'Hummus', unit: 'kg', stdRmCost: 145, stdYield: 2.10, shelfLifeHours: 96, usedIn: "Za'atar naan with hummus",
        bom: [['RM_CHICKPEA', 0.4762], ['RM_TAHINI', 0.10], ['RM_OLIVE_OIL', 0.04], ['RM_GARLIC', 0.03], ['RM_SPICE', 0.0233]] },
      { id: 'FP08', name: 'Toum / garlic sauce', unit: 'kg', stdRmCost: 200, stdYield: 1.00, shelfLifeHours: 120, usedIn: 'Shawarmas',
        bom: [['RM_OIL', 0.60], ['RM_GARLIC', 0.25], ['RM_LEMON', 0.06], ['RM_OLIVE_OIL', 0.05], ['RM_SPICE', 0.0364]], yieldBasis: 'total_input' },
      { id: 'FP09', name: 'Naan dough, portioned', unit: 'kg', stdRmCost: 36, stdYield: 1.60, shelfLifeHours: 48, usedIn: "Naan, masala naan, za'atar naan",
        bom: [['RM_MAIDA', 0.625], ['RM_CURD', 0.05], ['RM_OIL', 0.02], ['RM_SPICE', 0.0069]] }
    ],

    /* Bought locally by each outlet. unit is the recipe unit: qty in recipes is g, ml or pc; price is per kg, l or pc. */
    local: [
      { id: 'L_KHUBZ', name: 'Khubz bread', unit: 'pc', prices: [9, 9, 9, 9.5, 9.5, 9.5] },
      { id: 'L_RUMALI', name: 'Rumali roti', unit: 'pc', prices: [8, 8, 8, 8.5, 8.5, 8.5] },
      { id: 'L_ONION', name: 'Onion', unit: 'kg', prices: [25, 24, 28, 38, 52, 55] },
      { id: 'L_SALADVEG', name: 'Salad vegetables and herbs', unit: 'kg', prices: [60, 62, 68, 78, 82, 76] },
      { id: 'L_FRIES', name: 'Frozen fries', unit: 'kg', prices: [135, 135, 138, 138, 140, 140] },
      { id: 'L_PICKLE', name: 'Pickled vegetables', unit: 'kg', prices: flat(140) },
      { id: 'L_SAUCE', name: 'Mayonnaise, hot sauce and chutney base', unit: 'kg', prices: flat(190) },
      { id: 'L_OIL', name: 'Refined oil', unit: 'l', prices: [172, 175, 178, 182, 185, 183] },
      { id: 'L_BUTTER', name: 'Butter', unit: 'kg', prices: [570, 585, 600, 615, 630, 622] },
      { id: 'L_CREAM', name: 'Fresh cream', unit: 'l', prices: [240, 242, 244, 246, 249, 247] },
      { id: 'L_CURD', name: 'Curd', unit: 'kg', prices: [78, 79, 80, 82, 84, 83] },
      { id: 'L_CASHEW', name: 'Cashew (broken)', unit: 'kg', prices: [640, 655, 670, 685, 700, 690] },
      { id: 'L_ZAATAR', name: "Za'atar and olive oil blend", unit: 'kg', prices: flat(900) },
      { id: 'L_SPICE', name: 'Garnish spices and chaat masala', unit: 'kg', prices: flat(480) }
    ],

    /* Packaging, Rs per piece (sourced range Rs 8-25 per delivery order all-in). */
    packaging: [
      { id: 'PK_WRAP', name: 'Shawarma foil wrap and sleeve', unit: 'pc', prices: flat(3) },
      { id: 'PK_BOX_M', name: 'Kebab meal box', unit: 'pc', prices: flat(7.5) },
      { id: 'PK_BOX_S', name: 'Kebab box, counter', unit: 'pc', prices: flat(5) },
      { id: 'PK_TUB', name: 'Leak-proof tub 500 ml', unit: 'pc', prices: flat(6.5) },
      { id: 'PK_DIP', name: 'Dip cup 60 ml', unit: 'pc', prices: flat(1.2) },
      { id: 'PK_NAAN', name: 'Foil bread pouch', unit: 'pc', prices: flat(1.5) },
      { id: 'PK_BAG_D', name: 'Delivery bag, seal, tissue and cutlery', unit: 'pc', prices: flat(6.5) },
      { id: 'PK_BAG_T', name: 'Takeaway bag and tissue', unit: 'pc', prices: flat(2.5) }
    ]
  };

  config.factoryConversionPerKg = 70;
  config.items.factoryProducts.forEach(function (p) {
    p.conversionPerKg = config.factoryConversionPerKg;
    p.transferPrice = p.stdRmCost + p.conversionPerKg;
  });

  /* ---------------------------------------------------------- demand model */
  /*
   * Expected orders in an hour = baseOrders(outlet, stream) x hour share x ramp x day-of-week
   * x month phase x events x day noise; the engine then draws a Poisson count.
   * baseOrders = orders on a plain Monday-Thursday at ramp 1.0 (the level on ramp.refDate).
   * These are the main calibration knobs for the sales targets of RESEARCH.md section 2.
   */
  config.demand = {
    /*
     * The seed is a parameter like any other. With day noise of about 5% and Poisson draws of 100-180 orders per outlet-day, an
     * arbitrary seed hides some dated events behind noise (under 'mk-sales-v1' Bakri Eid at Koregaon Park and Independence Day did
     * not show). This one was picked from a scan of candidates because every marked event lands within about one standard
     * deviation of its configured effect at every outlet AND every calibration band of tools/check-data.js holds. To try another:
     * MK_DEMAND_SEED=<seed> node tools/check-data.js - the event section and the bands must all pass before it is adopted here.
     */
    seed: 'mk-sales-v825',
    baseOrders: {
      bandra: { pp_dinein: 30, pp_takeaway: 47, sw_delivery: 25, zo_delivery: 52 },
      andheri: { pp_dinein: 20, pp_takeaway: 37, sw_delivery: 62.5, zo_delivery: 54 },
      fort: { pp_dinein: 21, pp_takeaway: 67, sw_delivery: 24.5, zo_delivery: 34.5 },
      kalyan: { pp_dinein: 21, pp_takeaway: 29, sw_delivery: 28, zo_delivery: 37.5 },
      koregaon: { pp_dinein: 5.5, pp_takeaway: 16.5, sw_delivery: 43.5, zo_delivery: 49 }
    },
    /*
     * Compound monthly growth around refDate; Koregaon Park ramps to the end of August, then holds. Its endpoints in
     * RESEARCH.md section 2 (about Rs 13 L in April, about Rs 20 L by September) need about 11% a month, not the 7% quoted there.
     */
    ramp: {
      refDate: '2026-08-01',
      monthlyGrowth: { bandra: 0.01, andheri: 0.01, fort: 0.01, kalyan: 0.01, koregaon: 0.11 },
      flatAfter: { koregaon: '2026-08-31' }
    },
    /* Monday..Sunday */
    dow: {
      bandra: [1, 1, 1, 1, 1.15, 1.35, 1.30],
      andheri: [1, 1, 1, 1, 1.15, 1.35, 1.30],
      fort: [1, 1, 1, 1, 1.15, 0.95, 0.70],
      kalyan: [1, 0.93, 1, 0.93, 1.15, 1.35, 1.30],
      koregaon: [1, 1, 1, 1, 1.15, 1.35, 1.30]
    },
    /* Salary cycle: first week of the month up, last week down (stronger in Kalyan). */
    monthPhase: { firstDays: 7, firstMult: 1.06, lastDays: 7, lastMult: { bandra: 0.96, andheri: 0.96, fort: 0.96, kalyan: 0.93, koregaon: 0.96 } },
    /* Day-level noise: one factor shared by the network (weather, mood of the city) times one per outlet. */
    dayNoise: { networkSd: 0.03, outletSd: 0.035, clip: 0.10 },
    /* Share of a normal day by hour bucket 12..27 before clipping to opening hours. Aggregators skew later. */
    hourProfile: {
      instore: [3.4, 7.2, 7.2, 4.4, 3.6, 4.6, 6.0, 8.8, 12.4, 12.8, 10.0, 7.4, 5.4, 3.7, 2.1, 1.0],
      aggregator: [2.6, 6.2, 6.4, 3.8, 3.1, 3.9, 5.3, 8.4, 12.6, 13.5, 11.0, 8.8, 6.6, 4.4, 2.5, 0.9]
    },
    /* Outlet character: slot multipliers applied to the hour profile (then renormalised). */
    slotMult: {
      bandra: { all: { latenight: 1.20 } },
      andheri: { all: { latenight: 1.30 } },
      fort: { weekday: { lunch: 1.60, evening: 1.05, dinner: 0.80, latenight: 0.55 }, weekend: { lunch: 1.10, dinner: 0.90, latenight: 0.55 } },
      kalyan: { all: { lunch: 1.05, dinner: 1.05 } },
      koregaon: { all: { latenight: 1.05 } }
    }
  };

  /* ------------------------------------------------------------ order model */

  config.orderModel = {
    /* P(number of main-dish draws = 1, 2, 3, ...) by medium. Tables order more. */
    mainsCount: {
      dinein: [0.30, 0.42, 0.20, 0.07, 0.01],
      takeaway: [0.84, 0.14, 0.02],
      delivery: [0.75, 0.20, 0.04, 0.01]
    },
    /* Chance that a drawn main is ordered twice, by category. */
    doubleQtyChance: { shawarma: 0.16, rolls: 0.15, 'default': 0.04 },
    /* Relative popularity of mains by medium (butter_naan is an attach item, never a main draw). */
    dishWeights: {
      dinein: { angara_shawarma: 12, bc_shawarma: 7, paneer_shawarma: 4, changezi_tikka: 16, kashmiri_tikka: 10, angara_tikka: 11,
        chicken_seekh: 11, mutton_seekh: 7, butter_chicken: 13, zaatar_hummus: 7, bc_roll: 6 },
      takeaway: { angara_shawarma: 46, bc_shawarma: 17, paneer_shawarma: 9, changezi_tikka: 5, kashmiri_tikka: 3, angara_tikka: 5,
        chicken_seekh: 5, mutton_seekh: 2, butter_chicken: 4, zaatar_hummus: 1, bc_roll: 14 },
      delivery: { angara_shawarma: 30, bc_shawarma: 12, paneer_shawarma: 7, changezi_tikka: 11, kashmiri_tikka: 5, angara_tikka: 7,
        chicken_seekh: 8, mutton_seekh: 4, butter_chicken: 9, zaatar_hummus: 3, bc_roll: 10 }
    },
    /* Slot character: shawarma and rolls at lunch and late night, kebabs and gravy at dinner. */
    slotCategoryMult: {
      lunch: { shawarma: 1.25, rolls: 1.25, gravy: 0.90 },
      evening: { shawarma: 1.15, rolls: 1.15 },
      dinner: { signature_kebabs: 1.20, classic_kebabs: 1.15, seekh_kebabs: 1.15, gravy: 1.25, appetisers: 1.15 },
      latenight: { shawarma: 1.35, rolls: 1.30, gravy: 0.80, appetisers: 0.70 }
    },
    outletCategoryMult: {
      bandra: { signature_kebabs: 1.15, appetisers: 1.20 },
      fort: { shawarma: 1.10 },
      kalyan: { shawarma: 1.20, appetisers: 0.70 }
    },
    /* Butter naan attaches to kebab and gravy mains: chance per main unit, then 1 or 2 pieces. */
    naanAttach: {
      categories: ['signature_kebabs', 'classic_kebabs', 'seekh_kebabs', 'gravy'],
      chance: { dinein: 0.70, takeaway: 0.30, delivery: 0.45 },
      twoPiecesChance: { dinein: 0.50, takeaway: 0.25, delivery: 0.35 }
    }
  };

  /* Restaurant-funded discounts: share of orders carrying the offer x depth, capped (RESEARCH.md section 4). */
  config.discounts = {
    instore: { orderShare: 0.10, pct: 0.15, cap: 150 },
    aggregator: {
      bandra: { orderShare: 0.46, pct: 0.15, cap: 120 },
      andheri: { orderShare: 0.66, pct: 0.20, cap: 150 },
      fort: { orderShare: 0.46, pct: 0.15, cap: 120 },
      kalyan: { orderShare: 0.54, pct: 0.18, cap: 120 },
      koregaon: { orderShare: 0.66, pct: 0.20, cap: 150 }
    }
  };

  config.cancellation = {
    instore: 0.005,
    aggregator: { bandra: 0.020, andheri: 0.025, fort: 0.019, kalyan: 0.018, koregaon: 0.024 },
    reasons: {
      petpooja: ['Customer changed mind', 'Duplicate bill punched', 'Item not available', 'Long wait'],
      zomato: ['Restaurant rejected - item out of stock', 'Order timed out - not accepted', 'Customer cancelled', 'Rider not assigned'],
      swiggyCancelledBy: ['Customer', 'Restaurant', 'Swiggy']
    },
    approvers: ['Outlet manager', 'Shift supervisor']
  };

  /* In-store tender mix (A). Card MDR is a cost on card receipts; UPI is free. */
  config.paymentMix = { upi: 0.62, card: 0.18, cash: 0.20 };
  config.cardMdrPct = 0.009;
  config.zomatoPrepaidShare = 0.88;

  config.gst = { salesPct: 0.05, onAggregatorFeesPct: 0.18, note: 'Restaurant service at 5% without input tax credit; GST on aggregator orders is collected and paid by the aggregator under section 9(5)' };

  /* ------------------------------------------------------------------ events */
  /*
   * Dated demand effects (RESEARCH.md section 6). Each effect multiplies expected orders where its
   * optional conditions match: mediums, outlets, hours [from, to) in business-day hours, dows (0 = Mon).
   * cancelMult scales the cancellation probability. dishMult / categoryMult reshape the dish mix.
   */
  var RAIN = { effects: [{ mediums: ['delivery'], mult: 1.22 }, { mediums: ['dinein', 'takeaway'], mult: 0.65 }], cancelMult: { aggregator: 1.9, instore: 1.0 } };
  function rainDay(date) { return { id: 'rain_' + date, label: 'Heavy rain', kind: 'weather', from: date, to: date, marker: true, effects: RAIN.effects, cancelMult: RAIN.cancelMult }; }

  config.events = [
    { id: 'ipl', label: 'IPL season', kind: 'sport', from: '2026-04-01', to: '2026-05-31', marker: true,
      effects: [{ mediums: ['delivery'], hours: [19, 23], dows: [0, 1, 2, 3, 4], mult: 1.12 }, { mediums: ['delivery'], hours: [19, 23], dows: [5, 6], mult: 1.18 }] },
    { id: 'bakri_eid', label: 'Eid al-Adha (Bakri Eid)', kind: 'festival', from: '2026-05-27', to: '2026-05-28', marker: true,
      effects: [{ mult: 1.35 }], dishMult: { mutton_seekh: 2.6 }, categoryMult: { signature_kebabs: 1.2, seekh_kebabs: 1.2 } },
    { id: 'monsoon', label: 'Monsoon season', kind: 'weather', from: '2026-06-08', to: '2026-09-16', marker: false,
      effects: [{ mediums: ['delivery'], mult: 1.03 }, { mediums: ['dinein', 'takeaway'], mult: 0.97 }] },
    rainDay('2026-06-23'), rainDay('2026-07-07'), rainDay('2026-07-08'),
    { id: 'rain_extreme_2026-07-21', label: 'Extreme rain - city disrupted', kind: 'weather', from: '2026-07-21', to: '2026-07-21', marker: true,
      effects: [{ mult: 0.60 }], cancelMult: { aggregator: 3.2, instore: 2.0 } },
    rainDay('2026-08-04'), rainDay('2026-08-19'), rainDay('2026-09-02'),
    { id: 'shravan', label: 'Shravan', kind: 'festival', from: '2026-08-13', to: '2026-09-11', marker: true,
      effects: [{ outlets: ['kalyan', 'koregaon'], mult: 0.85 }, { outlets: ['bandra', 'andheri', 'fort'], mult: 0.93 }],
      categoryMult: { appetisers: 1.25 }, dishMult: { paneer_shawarma: 1.35 } },
    { id: 'independence_day', label: 'Independence Day', kind: 'holiday', from: '2026-08-15', to: '2026-08-15', marker: true, effects: [{ mult: 1.10 }] },
    { id: 'ganesh_chaturthi', label: 'Ganesh Chaturthi', kind: 'festival', from: '2026-09-14', to: '2026-09-14', marker: true,
      effects: [{ outlets: ['kalyan', 'koregaon'], mult: 0.65 }, { outlets: ['bandra', 'andheri', 'fort'], mult: 0.80 }] },
    { id: 'ganeshotsav', label: 'Ganeshotsav (first days)', kind: 'festival', from: '2026-09-15', to: '2026-09-16', marker: false,
      effects: [{ outlets: ['kalyan', 'koregaon'], mult: 0.82 }, { outlets: ['bandra', 'andheri', 'fort'], mult: 0.92 }] },
    /* beyond the data: entries the forecast applies to the coming weeks (the engine never generates orders past dataEnd) */
    { id: 'navratri', label: 'Navratri', kind: 'festival', from: '2026-10-11', to: '2026-10-19', marker: true,
      effects: [{ outlets: ['kalyan', 'koregaon'], mult: 0.84 }, { outlets: ['bandra', 'andheri', 'fort'], mult: 0.90 }],
      dishMult: { paneer_shawarma: 1.6, zaatar_hummus: 1.5, butter_naan: 1.2, mutton_seekh: 0.8, chicken_seekh: 0.85, angara_tikka: 0.85, kashmiri_tikka: 0.85, changezi_tikka: 0.85, butter_chicken: 0.9 } },
    { id: 'dussehra', label: 'Dussehra', kind: 'festival', from: '2026-10-20', to: '2026-10-20', marker: true,
      effects: [{ mult: 1.18 }], dishMult: { mutton_seekh: 1.4, chicken_seekh: 1.2 } }
  ];

  /* ----------------------------------------------------------- channel terms */
  /*
   * Assumed contract rates (label them "assumed" in the UI). weekStartDow: 0 = Monday ... 6 = Sunday.
   * feeBase 'net_plus_gst' = item total + packaging - restaurant discount + 5% GST; 'net' = the same without GST.
   * settledThrough = last calendar date covered by an uploaded statement (DATA-FEASIBILITY.md section 1).
   */
  config.channelTerms = {
    swiggy: {
      channelId: 'swiggy', ratesAssumed: true,
      serviceFeePct: 0.22, serviceFeePctByOutlet: { koregaon: 0.24 }, serviceFeeBase: 'net_plus_gst', serviceFeeLabel: 'Service fee',
      collectionFeePct: 0.02, collectionFeeBase: 'net_plus_gst', collectionFeeLabel: 'Payment collection charges',
      otherFeePct: 0.003, otherFeeBase: 'net_plus_gst', otherFeeLabel: 'Other platform fees',
      longDistanceFee: null,
      gstOnFeesPct: 0.18, tdsPct: 0.001, tdsBase: 'net', tdsLabel: 'TDS by e-commerce operator (0.1%)', tcsPct: 0,
      refundsPctOfNet: 0.008, refundsLagCycles: 1,
      cycle: { weekStartDow: 6, cutAtMonthEnd: true, settlementDow: 1, settlementRule: 'Tuesday after the Sunday-Saturday week', label: 'Sunday-Saturday, cut at month-end; settled the following Tuesday' },
      settledThrough: '2026-09-12', lastSettlementDate: '2026-09-15', statementSource: 'swiggy_annexure', statementName: 'payout annexure',
      utrPrefix: 'ICICN'
    },
    zomato: {
      channelId: 'zomato', ratesAssumed: true,
      serviceFeePct: 0.22, serviceFeePctByOutlet: { koregaon: 0.24 }, serviceFeeBase: 'net', serviceFeeLabel: 'Service fee (commission)',
      collectionFeePct: 0.0184, collectionFeeBase: 'net_plus_gst', collectionFeeLabel: 'Payment mechanism fee',
      otherFeePct: 0, otherFeeBase: 'net', otherFeeLabel: 'Long-distance fee',
      longDistanceFee: { orderShare: 0.08, min: 20, max: 40 },
      gstOnFeesPct: 0.18, tdsPct: 0.001, tdsBase: 'net', tdsLabel: 'TDS by e-commerce operator (0.1%)', tcsPct: 0,
      refundsPctOfNet: 0.008, refundsLagCycles: 1,
      cycle: { weekStartDow: 0, cutAtMonthEnd: false, settlementDow: 3, settlementRule: 'Thursday after the Monday-Sunday week', label: 'Monday-Sunday; paid by the following Thursday' },
      settledThrough: '2026-09-06', lastSettlementDate: '2026-09-10', statementSource: 'zomato_settlement', statementName: 'settlement report',
      utrPrefix: 'HDFCN'
    }
  };

  /* Ads deducted from payouts, as a share of aggregator menu value (amount deducted, GST included). */
  config.aggregatorAds = {
    pctOfMenuValue: { bandra: 0.03, andheri: 0.055, fort: 0.03, kalyan: 0.04, koregaon: 0.06 },
    cycleNoise: 0.10, gstIncluded: true
  };

  /* Seeded statement exceptions, applied by rule when statements are generated (RESEARCH.md section 4). */
  config.channelExceptions = [
    { id: 'EX_ZO_FORT_RATE', kind: 'rate_override', channelId: 'zomato', outletId: 'fort', from: '2026-08-03', to: '2026-08-16', serviceFeePct: 0.24 },
    { id: 'EX_SW_BANDRA_DEDUCTION', kind: 'unclassified_deduction', channelId: 'swiggy', outletId: 'bandra', from: '2026-08-23', to: '2026-08-29',
      amount: 14800, label: 'Unclassified deduction', disputeRaisedOn: '2026-09-03' },
    { id: 'EX_SW_KOREGAON_ADS', kind: 'ads_multiplier', channelId: 'swiggy', outletId: 'koregaon', from: '2026-08-30', to: '2026-09-05', mult: 2 }
  ];

  /* Audit rule thresholds used by MK.data.auditFlags. */
  config.auditRules = {
    commissionTolerancePct: 0.0025,    /* statement rate above contract by more than this -> flag */
    payoutToleranceRs: 50,             /* |expected - actual| within this -> MATCHED */
    adsSpikeRatio: 1.6,                /* ads share of menu value vs trailing average */
    adsTrailingCycles: 4,
    markupImpactMediumRs: 25000        /* markup flag severity: lost realisation in the period at or above this -> medium */
  };

  /* ------------------------------------------------ sources and capabilities */

  config.sources = {
    petpooja: { id: 'petpooja', label: 'Petpooja POS', caption: 'Petpooja POS - synced daily (through 16 Sep)', through: '2026-09-16', route: 'Pull API (T-1) with report export as fallback', frequency: 'Daily' },
    swiggy_annexure: { id: 'swiggy_annexure', label: 'Swiggy payout annexure', caption: 'Swiggy payout annexure - uploaded weekly (through 12 Sep)', through: '2026-09-12', route: 'Spreadsheet downloaded from the partner portal and uploaded', frequency: 'Weekly' },
    zomato_settlement: { id: 'zomato_settlement', label: 'Zomato settlement report', caption: 'Zomato settlement report - uploaded weekly (through 6 Sep)', through: '2026-09-06', route: 'Report downloaded from the partner portal and uploaded', frequency: 'Weekly' },
    erp: { id: 'erp', label: 'ERP', caption: 'Captured in ERP', through: null, route: 'Entered and approved in this system', frequency: 'Live' },
    estimate: { id: 'estimate', label: 'Estimate', caption: 'Estimated at contracted rates - actuals arrive with the weekly statement', through: null, route: 'Computed from contract terms', frequency: 'Until the statement is uploaded' },
    forecast: { id: 'forecast', label: 'Forecast', caption: 'Forecast - from Petpooja sales history and the event calendar', through: null, route: 'Level x weekday pattern x event calendar, the band from the last 8 weeks of forecast misses (js/data/forecast.js)', frequency: 'Recomputed on every view' }
  };

  /* Portal-only data that is never imported and never shown as data (DATA-FEASIBILITY.md section 3). */
  config.notImported = ['Funnel (impressions, menu opens, cart, orders)', 'Ads performance (impressions, clicks, ROAS, CPC)', 'Ratings and reviews',
    'Complaint text', 'Peer benchmarks', 'New vs repeat customer mix', 'Rider details and GPS',
    'Customer-side fees (platform fee, delivery fee, surge, tips)', 'Payment instrument split for aggregator orders', 'Competitor data',
    'Dish-level ratings', 'Any live feed of payouts'];

  function cap(label, petpooja, swiggy, zomato, note) { return { label: label, petpooja: petpooja, swiggy: swiggy, zomato: zomato, note: note || '' }; }
  var Y = 'yes', P = 'partial', N = 'no', NA = 'n/a';

  /* Keyed exactly by the fieldKeys of DATA-FEASIBILITY.md section 3. Values: yes | partial | no | n/a. */
  config.capabilities = {
    'order.id': cap('Order id', Y, Y, Y, 'Petpooja invoice numbers are unique only per outlet per day: key on outlet + business date + invoice no. The aggregator order id is kept alongside'),
    'order.timestamp': cap('Order time', Y, Y, Y),
    'order.status': cap('Order status', Y, Y, Y, 'Aggregator status events as recorded by the POS'),
    'order.items': cap('Item lines', Y, Y, Y, 'Item, quantity, unit price, line total, category, veg flag'),
    'order.subtotal': cap('Item subtotal', Y, Y, Y),
    'order.packagingCharge': cap('Packaging charge', Y, Y, Y),
    'order.discountTotal': cap('Discount total', Y, Y, Y),
    'order.discountRestaurantFunded': cap('Restaurant-funded discount', Y, P, Y, 'Swiggy: settled weeks only (annexure); the live relay discount is unsplit'),
    'order.discountPlatformFunded': cap('Platform-funded discount', NA, P, P, 'Weekly and by campaign only; left out of the order view; never reduces restaurant net'),
    'order.gst': cap('GST on the order', Y, Y, Y,'In-store: collected by the restaurant and payable. Aggregators: memo only - collected and paid by the aggregator under section 9(5)'),
    'order.paymentMode': cap('Payment mode', Y, N, P, 'Zomato: prepaid vs cash-on-delivery flag only'),
    'order.customerName': cap('Customer name', N, N, N, 'Left out of the mockup'),
    'order.customerPhone': cap('Customer phone', N, N, N, 'Left out of the mockup'),
    'order.customerAddress': cap('Customer address', NA, N, N, 'No locality, pincode or heat maps'),
    'order.newVsRepeat': cap('New vs repeat customer', N, N, N),
    'order.prepTime': cap('Preparation time', N, P, P, 'Derived from POS status times (accepted to food ready); depends on staff marking ready'),
    'order.riderWait': cap('Rider wait', NA, P, N, 'Left out of the mockup'),
    'order.deliveredTime': cap('Delivered time', NA, P, P, 'Where the delivered event is relayed'),
    'order.cancelReason': cap('Cancellation reason', Y, P, Y, 'Swiggy: "cancelled by" only, weekly from the annexure'),
    'order.deliveryDistance': cap('Delivery distance', NA, N, N, 'Statement only; left out'),
    'order.rating': cap('Order rating', N, N, N, 'Partner dashboard only'),
    'order.adAttribution': cap('Ad attribution', NA, N, N),
    'order.feesActual': cap('Aggregator fees - actual', NA, P, P, 'Settled weeks only: service fee, collection or payment-mechanism fee, GST on fees, TDS, order-level payout'),
    'order.feesEstimated': cap('Aggregator fees - estimated', NA, Y, Y, 'ERP estimate at contract rate x base, always labelled'),
    'payout.period': cap('Payout period', NA, Y, Y),
    'payout.settlementDate': cap('Settlement date', NA, Y, Y),
    'payout.utr': cap('Bank UTR', NA, Y, Y, 'Allows a match to the bank credit (the mockup shows the UTR; there is no bank feed)'),
    'payout.grossValue': cap('Gross order value', NA, Y, Y),
    'payout.restaurantDiscount': cap('Restaurant-funded discount', NA, Y, Y),
    'payout.netBillValue': cap('Net bill value', NA, Y, Y),
    'payout.commission': cap('Service fee / commission (% and amount)', NA, Y, Y),
    'payout.collectionFee': cap('Collection / payment mechanism fee', NA, Y, Y, 'Swiggy: payment collection charges 2%. Zomato: payment mechanism fee 1.84%'),
    'payout.gstOnFees': cap('GST on fees (18%)', NA, Y, Y, 'Non-creditable for a 5% restaurant: a real cost'),
    'payout.gstRetained9_5': cap('GST retained under section 9(5)', NA, Y, Y, 'Memo: retained and paid by the aggregator'),
    'payout.tds': cap('TDS by e-commerce operator (0.1%)', NA, Y, Y, 'A recoverable tax credit (asset), not an expense'),
    'payout.tcs': cap('TCS', NA, N, N, 'Nil - show nothing'),
    'payout.adsDeducted': cap('Ads deducted', NA, Y, Y, 'The only reconcilable ads number'),
    'payout.refundsAndCancellations': cap('Refunds and cancellation recoveries', NA, Y, Y, 'May land in a later cycle than the order'),
    'payout.otherDeductions': cap('Other deductions', NA, Y, Y, 'Swiggy: other platform fees. Zomato: long-distance fee, adjustments. Unexplained amounts are labelled "to be disputed"'),
    'payout.netPayout': cap('Net payout', NA, Y, Y),
    'inv.purchases': cap('Purchases (supplier, invoice, items, qty, price, tax)', P, NA, NA, 'Subject to Petpooja API enablement; report export fallback'),
    'inv.recipes': cap('Recipes', P, NA, NA, 'As good as recipe upkeep'),
    'inv.theoreticalConsumption': cap('Theoretical consumption', P, NA, NA, 'Theoretical only'),
    'inv.closingStock': cap('Closing stock', P, NA, NA, 'Book balance; physical only when counts are posted'),
    'inv.wastage': cap('Wastage', P, NA, NA, 'Depends on staff logging'),
    'inv.indents': cap('Indents', P, NA, NA, 'Quantities and transfer value'),
    'inv.transfers': cap('Transfers factory to outlet', P, NA, NA, 'Quantities and transfer value')
  };

  /* ------------------------------------------------------ expense categories */
  /* group = P&L block. units = which unit types carry the line. Order here is the P&L order. */

  function ec(id, label, group, units, note) { return { id: id, label: label, group: group, units: units, note: note || '' }; }
  var OUT = ['outlet'], FAC = ['factory'], HO = ['ho'], ALLU = ['outlet', 'factory', 'ho'];

  config.expenseGroups = [
    { id: 'cogs', label: 'Cost of goods sold' }, { id: 'channel', label: 'Channel costs' }, { id: 'people', label: 'People' },
    { id: 'occupancy', label: 'Occupancy' }, { id: 'utilities', label: 'Utilities' }, { id: 'operations', label: 'Operations' },
    { id: 'marketing', label: 'Marketing' }, { id: 'logistics', label: 'Logistics' }, { id: 'admin', label: 'Administration' },
    { id: 'below_ebitda', label: 'Below EBITDA' }
  ];

  config.expenseCategories = [
    ec('cogs_factory', 'Food cost - factory transfers', 'cogs', OUT, 'Factory products at transfer price'),
    ec('cogs_local', 'Food cost - local purchases', 'cogs', OUT, 'Bread, vegetables, dairy top-ups, oil'),
    ec('cogs_variance', 'Food cost variance (wastage and portioning)', 'cogs', OUT),
    ec('packaging', 'Delivery and takeaway packaging', 'cogs', OUT),
    ec('raw_materials', 'Raw materials', 'cogs', FAC),
    ec('production_consumables', 'Production consumables', 'cogs', FAC),
    ec('agg_commission', 'Aggregator service fees', 'channel', OUT),
    ec('agg_collection', 'Aggregator collection / payment fees', 'channel', OUT),
    ec('agg_other', 'Aggregator other fees and deductions', 'channel', OUT),
    ec('agg_gst_on_fees', 'GST on aggregator fees (non-creditable)', 'channel', OUT),
    ec('agg_ads', 'Aggregator ads', 'channel', OUT),
    ec('agg_refunds', 'Aggregator refunds and cancellations', 'channel', OUT),
    ec('card_mdr', 'Card MDR', 'channel', OUT),
    ec('salaries', 'Salaries and wages', 'people', ALLU),
    ec('employer_oncosts', 'Employer on-costs (PF, ESIC, bonus)', 'people', ALLU),
    ec('staff_meals', 'Staff meals', 'people', OUT),
    ec('staff_accommodation', 'Staff accommodation', 'people', OUT),
    ec('rent', 'Rent', 'occupancy', ALLU),
    ec('rent_gst', 'GST on rent (non-creditable)', 'occupancy', ALLU),
    ec('cam', 'CAM / society charges', 'occupancy', OUT),
    ec('electricity', 'Electricity', 'utilities', ALLU),
    ec('gas_lpg', 'Gas (commercial LPG)', 'utilities', ['outlet', 'factory']),
    ec('charcoal', 'Charcoal', 'utilities', OUT),
    ec('water', 'Water and waste', 'utilities', ['outlet', 'factory']),
    ec('housekeeping', 'Housekeeping and consumables', 'operations', OUT),
    ec('repairs', 'Repairs and maintenance', 'operations', ['outlet', 'factory']),
    ec('pest_waste', 'Pest control and waste', 'operations', OUT),
    ec('pos_internet', 'POS and internet', 'operations', OUT),
    ec('licences_insurance', 'Licences and insurance', 'operations', OUT),
    ec('lab_pest_licence', 'Lab testing, pest control and licences', 'operations', FAC),
    ec('petty_cash', 'Petty cash and miscellaneous', 'operations', OUT),
    ec('local_marketing', 'Local marketing', 'marketing', OUT),
    ec('logistics_allocation', 'Factory logistics allocation', 'logistics', OUT, 'By kg dispatched; Koregaon Park also bears the Pune run'),
    ec('vehicle_rent', 'Refrigerated van rental', 'logistics', FAC),
    ec('vehicle_fuel', 'Fuel and tolls', 'logistics', FAC),
    ec('pune_run', 'Pune run', 'logistics', FAC),
    ec('software', 'Software subscriptions', 'admin', HO),
    ec('professional_fees', 'Professional fees (CA retainer)', 'admin', HO),
    ec('office_admin', 'Office and administration', 'admin', ['factory', 'ho']),
    ec('depreciation', 'Depreciation', 'below_ebitda', ['outlet', 'factory'])
  ];

  /* --------------------------------------------------------- cost-centre tree */

  function dept(unitId, names) { return names.map(function (n) { return { id: 'cc_' + unitId + '_' + n.toLowerCase().replace(/[^a-z]+/g, '_'), label: n, unitId: unitId, children: [] }; }); }
  function outletCc(id, label) { return { id: 'cc_' + id, label: label, unitId: id, children: dept(id, ['Kitchen', 'Service', 'Delivery desk']) }; }

  config.costCentres = {
    id: 'cc_company', label: 'Miya Kebabs (company)', unitId: null, children: [
      { id: 'cc_mumbai', label: 'Mumbai region', unitId: null, children: [outletCc('bandra', 'Bandra'), outletCc('andheri', 'Andheri'), outletCc('fort', 'Fort'), outletCc('kalyan', 'Kalyan')] },
      { id: 'cc_pune', label: 'Pune', unitId: null, children: [outletCc('koregaon', 'Koregaon Park')] },
      { id: 'cc_factory', label: 'Factory (Central Kitchen)', unitId: 'factory', children: dept('factory', ['Production', 'Stores', 'Dispatch']) },
      { id: 'cc_ho', label: 'Head office', unitId: 'ho', children: dept('ho', ['Finance', 'Admin']) }
    ]
  };

  /* ------------------------------------------------------- cost parameters */
  /* Monthly, Rs, before tuning (RESEARCH.md section 5). The finance layer turns these into P&L lines.
   * headcount = the calibrated roster of config.wages.staffing; researchHeadcount = the figure of RESEARCH.md before tuning. */

  config.tariffs = {
    electricityPerKwh: { mumbai_licensee: 10.5, msedcl: 12.9 },
    electricitySeason: [1.10, 1.18, 1.08, 0.98, 0.97, 1.00],          /* Apr..Sep multiplier on base kWh */
    lpgCylinder19kg: [2031, 3024, 3067.5, 2885.5, 2691.5, 2701],       /* Apr..Sep, Mumbai, Rs per cylinder */
    lpgBudgetReference: 1642.5,                                        /* January price, the level budgets were set on */
    charcoalPerKg: 50
  };

  config.wages = {
    roles: [
      { id: 'outlet_manager', label: 'Outlet manager', gross: 35000 },
      { id: 'cashier', label: 'Cashier', gross: 17500 },
      { id: 'tandoor_cook', label: 'Tandoor / kebab cook', gross: 24000 },
      { id: 'shawarma_cook', label: 'Shawarma cook', gross: 21000 },
      { id: 'commis', label: 'Commis', gross: 18500 },
      { id: 'helper', label: 'Helper / packer', gross: 15500 },
      { id: 'cleaner', label: 'Cleaner', gross: 15000 }
    ],
    employerOnCostPct: 0.20,            /* PF about 13% on capped base, ESIC 3.25%, bonus 8.33% accrued monthly */
    minimumWageFloor: 14700,
    /*
     * Headcount by role, in the order of roles above: the CALIBRATED rosters the cost model uses. The 'before tuning' headcounts
     * of RESEARCH.md section 5 (18 / 18 / 16 / 14 / 11, kept as outletCosts[].researchHeadcount) could not meet the EBITDA bands
     * at these sales levels. The ordering follows the trade: Andheri, the longest day and the most orders, has the largest
     * team; Kalyan, the lowest Mumbai sales on the shortest day (13:00 to 23:45), the lightest Mumbai payroll (11 heads as at Bandra, with a helper in place of one commis).
     */
    staffing: {
      bandra: [1, 1, 2, 2, 2, 2, 1],     /* 11 - evening-only, one long shift */
      andheri: [1, 2, 2, 2, 2, 3, 1],    /* 13 */
      fort: [1, 1, 2, 2, 2, 3, 1],       /* 12 */
      kalyan: [1, 1, 2, 2, 1, 3, 1],     /* 11 - the same hours as Bandra on two thirds of its orders: the lightest payroll in Mumbai */
      koregaon: [1, 1, 2, 2, 1, 1, 0]    /* 8 - delivery-led, eight seats */
    }
  };

  config.outletCosts = {
    bandra: { rent: 270000, rentPerSqft: 600, cam: 6000, headcount: 11, researchHeadcount: 18, electricityKwh: 3000, lpgCylinders: 9, charcoal: 15000, water: 2500,
      localMarketingPct: 0.015, pettyCash: 8000, staffAccommodation: 25000, depreciation: 18000, foodCostVariancePts: 0.008 },
    andheri: { rent: 215000, rentPerSqft: 330, cam: 7000, headcount: 13, researchHeadcount: 18, electricityKwh: 4200, lpgCylinders: 12, charcoal: 18000, water: 3000,
      localMarketingPct: 0.012, pettyCash: 9000, staffAccommodation: 25000, depreciation: 24000, foodCostVariancePts: 0.012 },
    fort: { rent: 260000, rentPerSqft: 520, cam: 8000, headcount: 12, researchHeadcount: 16, electricityKwh: 3200, lpgCylinders: 8, charcoal: 12000, water: 2500,
      localMarketingPct: 0.010, pettyCash: 7000, staffAccommodation: 20000, depreciation: 20000, foodCostVariancePts: 0.010 },
    kalyan: { rent: 47500, rentPerSqft: 95, cam: 3000, headcount: 11, researchHeadcount: 14, electricityKwh: 3000, lpgCylinders: 8, charcoal: 12000, water: 2000,
      localMarketingPct: 0.015, pettyCash: 6000, staffAccommodation: 0, depreciation: 16000, foodCostVariancePts: 0.036,
      oneOffs: [{ month: '2026-08', categoryId: 'repairs', amount: 68000, label: 'Walk-in compressor failure' }] },
    koregaon: { rent: 92000, rentPerSqft: 230, cam: 4000, headcount: 8, researchHeadcount: 11, electricityKwh: 2400, lpgCylinders: 6, charcoal: 8000, water: 2000,
      localMarketingPct: 0.025, pettyCash: 5000, staffAccommodation: 15000, depreciation: 22000, foodCostVariancePts: 0.015 }
  };

  /* Lines that are the same at every outlet. */
  config.outletCostsCommon = {
    rentGstPct: 0.18,                       /* non-creditable for a 5% restaurant */
    housekeepingPctOfSales: 0.006,
    repairsPctOfSales: 0.015,               /* lumpy in practice */
    packagingCostPerOrder: { delivery: 16, takeaway: 7, dinein: 0 },
    pestControl: 2500, waste: 2000, posAndInternet: 2900, licencesAndInsurance: 3500,
    staffMealsPerHead: 2200,
    foodCostRedFlagPct: 0.38
  };

  config.factoryParams = {
    rent: 225000, rentGstPct: 0.18,
    staffing: [
      { role: 'Production head', count: 1, gross: 70000 }, { role: 'Chef de partie', count: 2, gross: 35000 },
      { role: 'Commis', count: 5, gross: 18500 }, { role: 'Helper', count: 4, gross: 15500 },
      { role: 'Storekeeper', count: 1, gross: 27000 }, { role: 'Purchase and dispatch', count: 1, gross: 27000 },
      { role: 'QA and hygiene', count: 1, gross: 30000 }, { role: 'Driver', count: 2, gross: 21500 }
    ],
    employerOnCostPct: 0.20,
    electricityKwh: 9500, electricityDemandCharge: 110000,
    lpgCylinders: 35,
    vans: { count: 2, rentEach: 35000, fuelAndTollsEach: 25000 },
    puneRunExtra: 45000, puneSupplyDays: 'alternate',
    repairsAmc: 10000, labPestLicence: 16000, waterAndWaste: 15000, admin: 20000,
    productionConsumablesPctOfTransferValue: 0.015,
    depreciation: 65000,
    capacityKgPerDay: 440,
    wastageTargetPct: [0.015, 0.03],
    fillRateTarget: { mumbai: [0.97, 0.99], koregaon: [0.92, 0.95] },
    /* Seeded story: chicken seekh mix yield falls from 106% to about 99% during August. */
    yieldExceptions: [{ sku: 'FP03', month: '2026-08', yield: 0.99 }],
    vendorCreditDays: { meat: [0, 7], vegetables: [0, 7], dairy: 7, dryGoodsAndPackaging: [15, 30], services: 30 }
  };

  config.headOffice = {
    staffing: [
      { role: 'Finance manager', count: 1, gross: 65000 }, { role: 'Accountant', count: 2, gross: 32000 },
      { role: 'Operations head', count: 1, gross: 90000 }, { role: 'HR and admin executive', count: 1, gross: 40000 }
    ],
    employerOnCostPct: 0.20,
    software: 22000, caRetainer: 45000, officeRent: 28000, rentGstPct: 0.18, officeAdmin: 9000
  };

  config.budgetPolicy = {
    basis: 'Budgets were set in March 2026 on the January-March run-rate; gas was budgeted at the January LPG price',
    warnAtPct: 0.90, overAtPct: 1.00
  };

  /* ------------------------------------------------------------ bank accounts */
  /* No balances and no account numbers beyond a masked last four (RESEARCH.md section 8). */

  function acct(id, bank, last4, purpose, unitId, txnsPerMonth, recommendation, note) {
    return { id: id, bank: bank, masked: 'XXXX' + last4, type: 'Current', purpose: purpose, unitId: unitId, txnsPerMonth: txnsPerMonth,
      activity: txnsPerMonth >= 150 ? 'high' : txnsPerMonth >= 40 ? 'medium' : txnsPerMonth > 0 ? 'low' : 'dormant', recommendation: recommendation, note: note || '' };
  }

  config.bankAccounts = {
    current: [
      acct('ba01', 'HDFC Bank', '4417', 'Main operating account - vendor payments', 'ho', 410, 'keep', 'Becomes the payments account of the target structure'),
      acct('ba02', 'HDFC Bank', '9082', 'Salary account', 'ho', 95, 'merge', 'Salaries can run from the payments account with a payroll file'),
      acct('ba03', 'HDFC Bank', '2250', 'Tax and statutory payments', 'ho', 22, 'keep', 'Ring-fenced for GST, TDS, PF and ESIC'),
      acct('ba04', 'ICICI Bank', '6631', 'Bandra collections - card and UPI settlements', 'bandra', 240, 'merge', 'Re-point the terminal settlements to the collections account'),
      acct('ba05', 'ICICI Bank', '6648', 'Bandra cash deposits', 'bandra', 28, 'close', 'Deposit cash into the collections account'),
      acct('ba06', 'Kotak Mahindra Bank', '1174', 'Andheri collections', 'andheri', 265, 'merge'),
      acct('ba07', 'Kotak Mahindra Bank', '1181', 'Andheri petty cash imprest', 'andheri', 35, 'close', 'Replace with a prepaid expense card'),
      acct('ba08', 'Axis Bank', '7306', 'Fort collections', 'fort', 230, 'merge'),
      acct('ba09', 'State Bank of India', '5529', 'Fort - legacy account from the fit-out loan', 'fort', 4, 'close', 'Loan closed; only bank charges pass through'),
      acct('ba10', 'Bank of Baroda', '8093', 'Kalyan collections and cash deposits', 'kalyan', 190, 'merge'),
      acct('ba11', 'Bank of Maharashtra', '3342', 'Koregaon Park collections', 'koregaon', 175, 'merge'),
      acct('ba12', 'Bank of Maharashtra', '3359', 'Koregaon Park local vendor payments', 'koregaon', 48, 'close', 'Pay Pune vendors from the payments account'),
      acct('ba13', 'ICICI Bank', '2716', 'Swiggy payouts (all outlets)', 'ho', 30, 'merge', 'Point aggregator payouts to the collections account'),
      acct('ba14', 'Axis Bank', '7398', 'Zomato payouts (all outlets)', 'ho', 26, 'merge'),
      acct('ba15', 'HDFC Bank', '5804', 'Factory purchases', 'factory', 320, 'merge', 'Factory vendors are paid through approved batches from the payments account'),
      acct('ba16', 'IDFC First Bank', '9920', 'Factory petty cash and fuel', 'factory', 60, 'close', 'Replace with fuel cards and an imprest card'),
      acct('ba17', 'Yes Bank', '4075', 'Legacy account - first Bandra outlet (2021)', 'ho', 0, 'close', 'Dormant'),
      acct('ba18', 'State Bank of India', '6112', 'Security deposits and landlord standing instructions', 'ho', 9, 'close', 'Move standing instructions to the payments account')
    ],
    target: [
      { id: 'bt1', bank: 'HDFC Bank', name: 'Collections account', purpose: 'All card, UPI, cash-deposit and aggregator payout credits, tagged by outlet', replaces: ['ba04', 'ba05', 'ba06', 'ba08', 'ba10', 'ba11', 'ba13', 'ba14'] },
      { id: 'bt2', bank: 'HDFC Bank', name: 'Payments account', purpose: 'Vendor payment batches released through maker-checker, salaries, rent', replaces: ['ba01', 'ba02', 'ba12', 'ba15', 'ba18'] },
      { id: 'bt3', bank: 'HDFC Bank', name: 'Tax and statutory account', purpose: 'GST, TDS, PF, ESIC, professional tax', replaces: ['ba03'] },
      { id: 'bt4', bank: 'HDFC Bank', name: 'Expense cards pool', purpose: 'Prepaid cards for outlet petty cash and factory fuel, with limits per unit', replaces: ['ba07', 'ba16'] }
    ],
    closeOutright: ['ba09', 'ba17']
  };

  /* ------------------------------------------------------------------ vendors */
  /*
   * Fictional master. GSTIN = state code 27 + PAN + entity number + Z + checksum (valid by the
   * standard mod-36 algorithm, see MK.data.gstinCheckChar). nameMatch = simulated penny-drop
   * name-match score (0-100). state is the onboarding state the seed starts from.
   * creditDays follow RESEARCH.md section 7 (meat, vegetables and dairy 7, dry goods and packaging 15-30, services 30) and are
   * terms the twice-weekly payment runs of MK.seed can meet: rent and staff housing, invoiced on the 1st, fall due on the 11th;
   * LPG distributors supply on a fortnightly account (A).
   */
  function vendor(id, name, category, unitIds, creditDays, pan, gstin, bank, ifsc, last4, categoryIds, extra) {
    var v = { id: id, name: name, type: 'vendor', category: category, unitIds: unitIds, creditDays: creditDays, pan: pan, gstin: gstin,
      bankName: bank, ifsc: ifsc, bankAccountMasked: 'XXXXXXXX' + last4, accountHolderName: name, nameMatch: 96, state: 'APPROVED',
      expenseCategoryIds: categoryIds, tdsLabel: null };
    if (extra) Object.keys(extra).forEach(function (k) { v[k] = extra[k]; });
    return v;
  }
  function utility(id, name, category, unitIds, categoryIds) {
    return { id: id, name: name, type: 'utility', category: category, unitIds: unitIds, creditDays: 15, pan: null, gstin: null, bankName: null, ifsc: null,
      bankAccountMasked: null, accountHolderName: null, nameMatch: null, state: 'APPROVED', expenseCategoryIds: categoryIds, tdsLabel: null };
  }
  var OUTLETS5 = ['bandra', 'andheri', 'fort', 'kalyan', 'koregaon'], MUM4 = ['bandra', 'andheri', 'fort', 'kalyan'];
  var ALL_UNITS = OUTLETS5.concat(['factory', 'ho']);

  config.vendors = [
    vendor('v_poultry', 'Noor Poultry Suppliers', 'Poultry', ['factory'], 7, 'AAGFN4821K', '27AAGFN4821K1Z3', 'HDFC Bank', 'HDFC0002841', '3381', ['raw_materials']),
    vendor('v_mutton', 'Qureshi Meat Traders', 'Mutton', ['factory'], 7, 'BHXPQ3327L', '27BHXPQ3327L1ZI', 'Bank of Baroda', 'BARB0DEONAR', '7754', ['raw_materials']),
    vendor('v_dairy', 'Gokul Dairy Distributors', 'Dairy', ['factory'].concat(OUTLETS5), 7, 'AAJFG7719M', '27AAJFG7719M1ZS', 'ICICI Bank', 'ICIC0001265', '9012', ['raw_materials', 'cogs_local']),
    vendor('v_veg', 'Sahyadri Fresh Vegetables', 'Vegetables', ['factory'].concat(MUM4), 7, 'CKTPS5528R', '27CKTPS5528R1ZT', 'State Bank of India', 'SBIN0011573', '4406', ['raw_materials', 'cogs_local']),
    vendor('v_dry', 'Malabar Spices and Provisions Pvt Ltd', 'Dry goods and spices', ['factory'].concat(OUTLETS5), 30, 'AAKCM2264P', '27AAKCM2264P1ZV', 'Kotak Mahindra Bank', 'KKBK0000652', '1897', ['raw_materials', 'cogs_local']),
    vendor('v_oil', 'Deccan Edible Oils', 'Oil', ['factory'].concat(OUTLETS5), 21, 'AAQFD9043H', '27AAQFD9043H1Z2', 'Axis Bank', 'UTIB0000373', '6620', ['raw_materials', 'cogs_local']),
    vendor('v_pack', 'Ecowrap Packaging Solutions LLP', 'Packaging', OUTLETS5, 30, 'AARFE6612J', '27AARFE6612J1Z2', 'HDFC Bank', 'HDFC0000540', '2743', ['packaging']),
    vendor('v_charcoal', 'Konkan Charcoal Depot', 'Charcoal', OUTLETS5, 15, 'DLMPK8890B', '27DLMPK8890B1ZN', 'Bank of Maharashtra', 'MAHB0000318', '5168', ['charcoal']),
    vendor('v_lpg_mum', 'Shree Sai Gas Agency', 'LPG distributor', MUM4.concat(['factory']), 15, 'ABCFS3178D', '27ABCFS3178D1Z7', 'State Bank of India', 'SBIN0004402', '8835', ['gas_lpg']),
    vendor('v_lpg_pune', 'Pune Flame Distributors', 'LPG distributor', ['koregaon'], 15, 'AAXFP4409C', '27AAXFP4409C1Z1', 'Bank of Maharashtra', 'MAHB0001129', '3057', ['gas_lpg']),
    vendor('v_ll_bandra', 'Pali Hill Realty LLP', 'Landlord', ['bandra'], 10, 'AAMFP2157G', '27AAMFP2157G1Z3', 'HDFC Bank', 'HDFC0000118', '6294', ['rent', 'rent_gst', 'cam'], { tdsLabel: 'TDS - rent' }),
    vendor('v_ll_andheri', 'Oshiwara Link Properties Pvt Ltd', 'Landlord', ['andheri'], 10, 'AACCO7782N', '27AACCO7782N1ZO', 'ICICI Bank', 'ICIC0000347', '1540', ['rent', 'rent_gst', 'cam'], { tdsLabel: 'TDS - rent' }),
    vendor('v_ll_fort', 'Heritage Fort Estates', 'Landlord', ['fort'], 10, 'AATFH5630Q', '27AATFH5630Q1ZJ', 'Axis Bank', 'UTIB0000004', '7719', ['rent', 'rent_gst', 'cam'], { tdsLabel: 'TDS - rent' }),
    vendor('v_ll_kalyan', 'Suresh Bhoir', 'Landlord', ['kalyan'], 10, 'BQKPB6174E', '27BQKPB6174E1ZV', 'Bank of Baroda', 'BARB0KALYAN', '4863', ['rent', 'rent_gst', 'cam'], { tdsLabel: 'TDS - rent' }),
    vendor('v_ll_koregaon', 'Lane Six Properties', 'Landlord', ['koregaon'], 10, 'AAWFL3925T', '27AAWFL3925T1Z4', 'Bank of Maharashtra', 'MAHB0000941', '2206', ['rent', 'rent_gst', 'cam'], { tdsLabel: 'TDS - rent' }),
    vendor('v_ll_factory', 'Mahalaxmi Industrial Estates Pvt Ltd', 'Landlord', ['factory', 'ho'], 10, 'AAFCM8846R', '27AAFCM8846R1ZG', 'HDFC Bank', 'HDFC0001002', '9471', ['rent', 'rent_gst'], { tdsLabel: 'TDS - rent' }),
    vendor('v_pest', 'SafeGuard Pest Management', 'Pest control', OUTLETS5.concat(['factory']), 30, 'AAYFS1093L', '27AAYFS1093L1ZC', 'Kotak Mahindra Bank', 'KKBK0001388', '6038', ['pest_waste', 'lab_pest_licence'], { tdsLabel: 'TDS - contractor / transport' }),
    vendor('v_waste', 'CleanCity Waste Services', 'Waste collection', OUTLETS5.concat(['factory']), 30, 'ABDFC5547K', '27ABDFC5547K1Z6', 'ICICI Bank', 'ICIC0002210', '7142', ['pest_waste', 'water'], { tdsLabel: 'TDS - contractor / transport' }),
    vendor('v_amc', 'Polar Refrigeration Services', 'Refrigeration AMC', OUTLETS5.concat(['factory']), 30, 'CFRPP7261H', '27CFRPP7261H1ZS', 'State Bank of India', 'SBIN0007719', '3925', ['repairs'], { tdsLabel: 'TDS - contractor / transport' }),
    vendor('v_internet', 'MetroNet Broadband Pvt Ltd', 'Internet', ALL_UNITS, 15, 'AAGCM3318F', '27AAGCM3318F1ZN', 'HDFC Bank', 'HDFC0000060', '8810', ['pos_internet', 'office_admin']),
    vendor('v_pos', 'Tableside Tech Solutions Pvt Ltd', 'POS subscription', OUTLETS5, 15, 'AAHCT9920B', '27AAHCT9920B1ZB', 'ICICI Bank', 'ICIC0000104', '4527', ['pos_internet', 'software']),
    vendor('v_ca', 'Joshi Kamat and Associates', 'CA firm', ['ho'], 30, 'AAKFJ4475D', '27AAKFJ4475D1Z8', 'Axis Bank', 'UTIB0001526', '6673', ['professional_fees'], { tdsLabel: 'TDS - professional fees' }),
    vendor('v_hk', 'Spick Housekeeping Supplies', 'Housekeeping supplies', OUTLETS5.concat(['factory']), 21, 'BNGPS1842M', '27BNGPS1842M1ZI', 'Bank of Baroda', 'BARB0ANDHER', '2981', ['housekeeping', 'production_consumables']),
    vendor('v_accom', 'Sunrise Staff Housing', 'Staff accommodation', ['bandra', 'andheri', 'fort', 'koregaon'], 10, 'AVTPS6039C', '27AVTPS6039C1Z4', 'State Bank of India', 'SBIN0000300', '5316', ['staff_accommodation'], { tdsLabel: 'TDS - rent' }),
    vendor('v_van', 'ColdChain Wheels Rentals', 'Refrigerated van rental', ['factory'], 30, 'AAPFC7154N', '27AAPFC7154N1ZR', 'Kotak Mahindra Bank', 'KKBK0000958', '7460', ['vehicle_rent', 'pune_run'], { tdsLabel: 'TDS - contractor / transport' }),
    vendor('v_insure', 'Western Shield Insurance Brokers Pvt Ltd', 'Insurance', ALL_UNITS, 15, 'AALCW6673P', '27AALCW6673P1Z7', 'HDFC Bank', 'HDFC0000291', '1208', ['licences_insurance']),
    /* Low bank-name match: the account is held in the proprietor's personal name. */
    vendor('v_print', 'Inkwell Print and Media', 'Printing and marketing', OUTLETS5, 30, 'CXDPI4417G', '27CXDPI4417G1ZM', 'Yes Bank', 'YESB0000417', '8846', ['local_marketing'],
      { accountHolderName: 'Imtiyaz R Khan', nameMatch: 38, state: 'NEEDS_REVIEW' }),
    /* Not yet approved. */
    vendor('v_lab', 'AccuTest Food Labs Pvt Ltd', 'Lab testing', ['factory'], 30, 'AAICA2586J', '27AAICA2586J1ZC', 'ICICI Bank', 'ICIC0003306', '5093', ['lab_pest_licence'],
      { state: 'VERIFYING', tdsLabel: 'TDS - professional fees' }),
    vendor('v_pack2', 'GreenLeaf Containers', 'Packaging', OUTLETS5, 30, 'DKWPG2290A', '27DKWPG2290A1Z3', 'IDFC First Bank', 'IDFB0040112', '6657', ['packaging'], { state: 'DRAFT' }),
    /* Turned down at onboarding: the account is held in a personal name and no supporting document was produced. */
    vendor('v_frozen', 'Crescent Frozen Foods', 'Poultry', ['factory'], 15, 'AAHFC6158E', '27AAHFC6158E1ZG', 'IDFC First Bank', 'IDFB0040233', '7291', ['raw_materials'],
      { accountHolderName: 'Salim Y Patel', nameMatch: 44, state: 'REJECTED',
        rejectionReason: 'Bank account is held in a personal name and the firm did not send a cancelled cheque or a bank letter; FSSAI licence copy also missing. To re-apply with documents.' }),
    utility('u_elec_mum', 'Mumbai electricity licensee (biller)', 'Electricity', ['bandra', 'andheri', 'fort', 'factory', 'ho'], ['electricity']),
    utility('u_elec_msedcl', 'MSEDCL (biller)', 'Electricity', ['kalyan', 'koregaon'], ['electricity']),
    utility('u_water', 'Municipal water charges (biller)', 'Water', OUTLETS5.concat(['factory']), ['water'])
  ];

  /* ---------------------------------------------------- helpers that belong here */

  var data = MK.data || (MK.data = {});

  /** Raw capability record {label, petpooja, swiggy, zomato, note} or null. */
  data.capability = function (fieldKey) {
    return Object.prototype.hasOwnProperty.call(config.capabilities, fieldKey) ? config.capabilities[fieldKey] : null;
  };

  /** 'yes' | 'partial' | 'no'. Unknown channel, unknown field and 'n/a' all answer 'no'. */
  data.can = function (channelId, fieldKey) {
    var c = data.capability(fieldKey);
    var v = c ? c[channelId] : null;
    return v === 'yes' || v === 'partial' ? v : 'no';
  };

  var GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  /** Check character for the first 14 characters of a GSTIN (standard mod-36 algorithm). */
  data.gstinCheckChar = function (first14) {
    var sum = 0;
    for (var i = 0; i < 14; i++) {
      var v = GSTIN_CHARS.indexOf(String(first14).charAt(i));
      if (v < 0) return null;
      var p = v * (i % 2 === 0 ? 1 : 2);
      sum += Math.floor(p / 36) + (p % 36);
    }
    return GSTIN_CHARS.charAt((36 - (sum % 36)) % 36);
  };

  /* No prototype: an id such as 'constructor' or '__proto__' (route parameters are user-editable) must read as unknown. */
  function byId(list) { var m = Object.create(null); list.forEach(function (x) { m[x.id] = x; }); return m; }
  function own(o, k) { return !!o && typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k); }
  var dishById = byId(config.dishes), fpById = byId(config.items.factoryProducts);
  var priceItems = byId(config.items.local.concat(config.items.packaging));

  function monthIndex(monthKey) { var i = MONTHS.indexOf(monthKey); return i < 0 ? MONTHS.length - 1 : i; }
  /* Recipe quantities are g / ml for items priced per kg / l, and pieces for items priced per piece. */
  function lineCost(l, mi) { var it = priceItems[l.itemId]; if (!it) return 0; var p = it.prices[mi]; return it.unit === 'pc' ? p * l.qty : p * l.qty / 1000; }

  /** POS price of a dish on a date (ISO), honouring priceChanges. */
  data.posPriceOn = function (dishId, isoDate) {
    var d = dishById[dishId]; if (!d) return null;
    var p = d.posPrice;
    d.priceChanges.forEach(function (c) { if (c.list === 'pos' && c.date <= isoDate) p = c.price; });
    return p;
  };

  /** Aggregator menu price of a dish at an outlet on a date, or null when it is not sold there. */
  data.aggPriceOn = function (dishId, outletId, isoDate) {
    var d = dishById[dishId]; if (!d || !own(d.aggPrices, outletId)) return null;
    var p = d.aggPrices[outletId];
    d.priceChanges.forEach(function (c) { if (c.list === 'agg' && c.date <= isoDate && (!c.outletId || c.outletId === outletId)) p = c.price; });
    return p;
  };

  data.dishSoldAt = function (dishId, outletId) {
    var d = dishById[dishId];
    return !!d && (!d.availableAt || d.availableAt.indexOf(outletId) !== -1);
  };

  /**
   * Theoretical (recipe) cost of one portion, unrounded rupees: factory SKUs at transfer price,
   * local items at the month's price, per-dish packaging for the medium (none for dine-in).
   * recipeCost(dishId, { monthKey, mediumId }) -> { factory, local, packaging, food, total }
   */
  data.recipeCost = function (dishId, opts) {
    var d = dishById[dishId]; if (!d) return null;
    opts = opts || {};
    var mi = monthIndex(opts.monthKey), factory = 0, local = 0, packaging = 0;
    d.recipe.factory.forEach(function (l) { factory += fpById[l.sku].transferPrice * l.g / 1000; });
    d.recipe.local.forEach(function (l) { local += lineCost(l, mi); });
    (own(d.recipe.packaging, opts.mediumId) ? d.recipe.packaging[opts.mediumId] : []).forEach(function (l) { packaging += lineCost(l, mi); });
    return { factory: factory, local: local, packaging: packaging, food: factory + local, total: factory + local + packaging };
  };

  /** Cost of the once-per-order packaging for a medium in a month. */
  data.orderPackagingCost = function (mediumId, monthKey) {
    var mi = monthIndex(monthKey), c = 0;
    (own(config.orderPackaging, mediumId) ? config.orderPackaging[mediumId] : []).forEach(function (l) { c += lineCost(l, mi); });
    return c;
  };

  MK.config = config;
  if (typeof module !== 'undefined' && module.exports) module.exports = root.MK;
})(typeof window !== 'undefined' ? window : globalThis);
