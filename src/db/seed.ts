import { randomUUID } from 'node:crypto';
import { createDbFromEnv, type Db } from './client.js';
import { migrate } from './migrate.js';

/**
 * Generates a catalog at the scale the brief describes.
 *
 * The default is 200,000 products, because "a few hundred thousand" is the stated
 * scale and index behaviour is only interesting at scale. With a few dozen rows
 * Postgres ignores every index and sequentially scans, so a benchmark on a small
 * fixture would measure nothing and would happily hide a missing index.
 *
 *   npm run seed              # 200,000
 *   COUNT=500000 npm run seed
 */

/**
 * A product family: brand, category, product line and price band, chosen together.
 *
 * This is the important detail. An earlier version picked brand, line and category
 * from three independent lists, which cheerfully attached a rival manufacturer's
 * name to Nike's own product lines, in a category unrelated to either.
 * Independent random draws across correlated columns produce data that is
 * plausible field by field and nonsense as a row.
 *
 * Tying them into one record also makes the filters meaningful: `category=Football`
 * returns boots, not a random tenth of the catalog, so a price-range filter within
 * a category exercises the composite index the way real traffic would.
 *
 * Brands are Nike, Jordan and Converse — all Nike, Inc. Three brands is enough to
 * demonstrate a brand filter without putting a competitor in the dataset.
 */
type Tier = 'accessory' | 'apparel' | 'core' | 'premium';

interface Family {
  brand: 'Nike' | 'Jordan' | 'Converse';
  category: string;
  /** Display line, including the brand word where that is how it is actually written. */
  line: string;
  tier: Tier;
}

const FAMILIES: Family[] = [
  // --- Nike, Running -------------------------------------------------------
  { brand: 'Nike', category: 'Running', line: 'Nike Air Zoom Pegasus 41', tier: 'core' },
  { brand: 'Nike', category: 'Running', line: 'Nike Vomero 18', tier: 'core' },
  { brand: 'Nike', category: 'Running', line: 'Nike Air Zoom Structure 25', tier: 'core' },
  { brand: 'Nike', category: 'Running', line: 'Nike InfinityRN 4', tier: 'core' },
  { brand: 'Nike', category: 'Running', line: 'Nike Zoom Fly 6', tier: 'core' },
  { brand: 'Nike', category: 'Running', line: 'Nike Free RN NN', tier: 'core' },
  { brand: 'Nike', category: 'Running', line: 'Nike Invincible 3', tier: 'premium' },
  { brand: 'Nike', category: 'Running', line: 'Nike Vaporfly 3', tier: 'premium' },
  { brand: 'Nike', category: 'Running', line: 'Nike Alphafly 3', tier: 'premium' },

  // --- Nike, Basketball ----------------------------------------------------
  { brand: 'Nike', category: 'Basketball', line: 'Nike LeBron XXII', tier: 'premium' },
  { brand: 'Nike', category: 'Basketball', line: 'Nike KD17', tier: 'premium' },
  { brand: 'Nike', category: 'Basketball', line: 'Nike G.T. Cut 3', tier: 'premium' },
  { brand: 'Nike', category: 'Basketball', line: 'Nike G.T. Jump 3', tier: 'core' },
  { brand: 'Nike', category: 'Basketball', line: 'Nike Giannis Immortality 4', tier: 'core' },
  { brand: 'Nike', category: 'Basketball', line: 'Nike Sabrina 2', tier: 'core' },
  { brand: 'Nike', category: 'Basketball', line: 'Nike Book 1', tier: 'core' },

  // --- Nike, Football ------------------------------------------------------
  { brand: 'Nike', category: 'Football', line: 'Nike Mercurial Vapor 16', tier: 'premium' },
  { brand: 'Nike', category: 'Football', line: 'Nike Mercurial Superfly 10', tier: 'premium' },
  { brand: 'Nike', category: 'Football', line: 'Nike Phantom GX 2', tier: 'premium' },
  { brand: 'Nike', category: 'Football', line: 'Nike Phantom Luna 2', tier: 'premium' },
  { brand: 'Nike', category: 'Football', line: 'Nike Tiempo Legend 10', tier: 'core' },
  { brand: 'Nike', category: 'Football', line: 'Nike Premier 3', tier: 'core' },

  // --- Nike, Lifestyle -----------------------------------------------------
  { brand: 'Nike', category: 'Lifestyle', line: 'Nike Air Max 90', tier: 'core' },
  { brand: 'Nike', category: 'Lifestyle', line: 'Nike Air Max 97', tier: 'core' },
  { brand: 'Nike', category: 'Lifestyle', line: 'Nike Air Max 1', tier: 'core' },
  { brand: 'Nike', category: 'Lifestyle', line: 'Nike Air Max Plus', tier: 'core' },
  { brand: 'Nike', category: 'Lifestyle', line: 'Nike Air Force 1 07', tier: 'core' },
  { brand: 'Nike', category: 'Lifestyle', line: 'Nike Dunk Low Retro', tier: 'core' },
  { brand: 'Nike', category: 'Lifestyle', line: 'Nike Dunk High Retro', tier: 'core' },
  { brand: 'Nike', category: 'Lifestyle', line: 'Nike Blazer Mid 77', tier: 'core' },
  { brand: 'Nike', category: 'Lifestyle', line: 'Nike Cortez', tier: 'core' },
  { brand: 'Nike', category: 'Lifestyle', line: 'Nike Killshot 2', tier: 'core' },
  { brand: 'Nike', category: 'Lifestyle', line: 'Nike Waffle Debut', tier: 'core' },
  { brand: 'Nike', category: 'Lifestyle', line: 'Nike V2K Run', tier: 'core' },
  { brand: 'Nike', category: 'Lifestyle', line: 'Nike P-6000', tier: 'core' },

  // --- Nike, Training ------------------------------------------------------
  { brand: 'Nike', category: 'Training', line: 'Nike Metcon 9', tier: 'core' },
  { brand: 'Nike', category: 'Training', line: 'Nike Free Metcon 6', tier: 'core' },
  { brand: 'Nike', category: 'Training', line: 'Nike Zoom SuperRep 4', tier: 'core' },
  { brand: 'Nike', category: 'Training', line: 'Nike Romaleos 4', tier: 'premium' },

  // --- Nike, Tennis --------------------------------------------------------
  { brand: 'Nike', category: 'Tennis', line: 'NikeCourt Air Zoom Vapor Pro 2', tier: 'core' },
  { brand: 'Nike', category: 'Tennis', line: 'NikeCourt Zoom GP Challenge 1', tier: 'core' },
  { brand: 'Nike', category: 'Tennis', line: 'NikeCourt Vapor Lite 2', tier: 'core' },
  { brand: 'Nike', category: 'Tennis', line: 'NikeCourt Legacy', tier: 'core' },

  // --- Nike, Skateboarding -------------------------------------------------
  { brand: 'Nike', category: 'Skateboarding', line: 'Nike SB Dunk Low Pro', tier: 'core' },
  { brand: 'Nike', category: 'Skateboarding', line: 'Nike SB Blazer Court', tier: 'core' },
  { brand: 'Nike', category: 'Skateboarding', line: 'Nike SB Zoom Janoski OG+', tier: 'core' },
  { brand: 'Nike', category: 'Skateboarding', line: 'Nike SB Nyjah Free 2', tier: 'core' },

  // --- Nike, Outdoor -------------------------------------------------------
  { brand: 'Nike', category: 'Outdoor', line: 'Nike ACG Mountain Fly 2 Low', tier: 'premium' },
  { brand: 'Nike', category: 'Outdoor', line: 'Nike ACG Lowcate', tier: 'core' },
  { brand: 'Nike', category: 'Outdoor', line: 'Nike ACG Air Deschutz+', tier: 'core' },
  { brand: 'Nike', category: 'Outdoor', line: 'Nike Pegasus Trail 5', tier: 'core' },

  // --- Nike, Apparel -------------------------------------------------------
  {
    brand: 'Nike',
    category: 'Apparel',
    line: 'Nike Sportswear Club Fleece Hoodie',
    tier: 'apparel',
  },
  { brand: 'Nike', category: 'Apparel', line: 'Nike Tech Fleece Joggers', tier: 'apparel' },
  { brand: 'Nike', category: 'Apparel', line: 'Nike Dri-FIT ADV TechKnit Tee', tier: 'apparel' },
  { brand: 'Nike', category: 'Apparel', line: 'Nike Pro 365 Tights', tier: 'apparel' },
  { brand: 'Nike', category: 'Apparel', line: 'Nike Windrunner Jacket', tier: 'apparel' },
  { brand: 'Nike', category: 'Apparel', line: 'Nike Strike Drill Top', tier: 'apparel' },
  { brand: 'Nike', category: 'Apparel', line: 'Nike Dri-FIT Academy Shorts', tier: 'apparel' },

  // --- Nike, Accessories ---------------------------------------------------
  { brand: 'Nike', category: 'Accessories', line: 'Nike Heritage Backpack', tier: 'accessory' },
  { brand: 'Nike', category: 'Accessories', line: 'Nike Brasilia Duffel', tier: 'accessory' },
  {
    brand: 'Nike',
    category: 'Accessories',
    line: 'Nike Everyday Plus Crew Socks',
    tier: 'accessory',
  },
  { brand: 'Nike', category: 'Accessories', line: 'Nike Dri-FIT Club Cap', tier: 'accessory' },
  { brand: 'Nike', category: 'Accessories', line: 'Nike Swoosh Headband', tier: 'accessory' },

  // --- Jordan --------------------------------------------------------------
  { brand: 'Jordan', category: 'Basketball', line: 'Air Jordan 39', tier: 'premium' },
  { brand: 'Jordan', category: 'Basketball', line: 'Jordan Luka 3', tier: 'core' },
  { brand: 'Jordan', category: 'Basketball', line: 'Jordan Tatum 2', tier: 'core' },
  { brand: 'Jordan', category: 'Basketball', line: 'Jordan Zion 3', tier: 'core' },
  { brand: 'Jordan', category: 'Lifestyle', line: 'Air Jordan 1 Retro High OG', tier: 'premium' },
  { brand: 'Jordan', category: 'Lifestyle', line: 'Air Jordan 1 Low', tier: 'core' },
  { brand: 'Jordan', category: 'Lifestyle', line: 'Air Jordan 3 Retro', tier: 'premium' },
  { brand: 'Jordan', category: 'Lifestyle', line: 'Air Jordan 4 Retro', tier: 'premium' },
  { brand: 'Jordan', category: 'Lifestyle', line: 'Air Jordan 11 Retro', tier: 'premium' },
  { brand: 'Jordan', category: 'Lifestyle', line: 'Jordan Stadium 90', tier: 'core' },
  { brand: 'Jordan', category: 'Apparel', line: 'Jordan Jumpman Fleece Hoodie', tier: 'apparel' },
  { brand: 'Jordan', category: 'Apparel', line: 'Jordan Dri-FIT Sport Shorts', tier: 'apparel' },
  { brand: 'Jordan', category: 'Accessories', line: 'Jordan Velocity Backpack', tier: 'accessory' },
  {
    brand: 'Jordan',
    category: 'Accessories',
    line: 'Jordan Jumpman Crew Socks',
    tier: 'accessory',
  },

  // --- Converse ------------------------------------------------------------
  {
    brand: 'Converse',
    category: 'Lifestyle',
    line: 'Converse Chuck Taylor All Star',
    tier: 'core',
  },
  { brand: 'Converse', category: 'Lifestyle', line: 'Converse Chuck 70', tier: 'core' },
  { brand: 'Converse', category: 'Lifestyle', line: 'Converse Jack Purcell', tier: 'core' },
  { brand: 'Converse', category: 'Lifestyle', line: 'Converse Run Star Hike', tier: 'core' },
  { brand: 'Converse', category: 'Lifestyle', line: 'Converse Pro Leather', tier: 'core' },
  {
    brand: 'Converse',
    category: 'Skateboarding',
    line: 'Converse CONS One Star Pro',
    tier: 'core',
  },
  { brand: 'Converse', category: 'Skateboarding', line: 'Converse CONS AS-1 Pro', tier: 'core' },
  { brand: 'Converse', category: 'Apparel', line: 'Converse Go-To Chuck Hoodie', tier: 'apparel' },
  {
    brand: 'Converse',
    category: 'Accessories',
    line: 'Converse Speed 3 Backpack',
    tier: 'accessory',
  },
];

/** Nike-authentic colourway names, so the variant axis reads like a real catalog. */
const COLOURWAYS = [
  'Black/White',
  'White/Wolf Grey',
  'Triple Black',
  'Black/University Red',
  'University Blue',
  'Volt/Black',
  'Sail/Light Bone',
  'Midnight Navy',
  'Photon Dust',
  'Olive/Khaki',
  'White/Black',
  'Court Purple',
  'Summit White',
  'Anthracite',
];

const SIZES = ['UK 6', 'UK 7', 'UK 8', 'UK 9', 'UK 10', 'UK 11', 'UK 12'];

/** Rupee bands per tier, so an accessory never costs more than a premium boot. */
const PRICE_BANDS: Record<Tier, [number, number]> = {
  accessory: [495, 4_995],
  apparel: [1_995, 12_995],
  core: [4_995, 15_995],
  premium: [15_995, 28_995],
};

const CATEGORY_BLURB: Record<string, string> = {
  Running: 'Responsive cushioning for everyday miles.',
  Basketball: 'Built for containment and quick change of direction.',
  Football: 'Precision touch on firm ground.',
  Lifestyle: 'An everyday icon, kept as it was.',
  Training: 'Stable under load, flexible through the warm-up.',
  Tennis: 'Court-ready support through the lateral game.',
  Skateboarding: 'Reinforced where the board wears through.',
  Outdoor: 'All-terrain traction and weather-ready coverage.',
  Apparel: 'Sweat-wicking fabric with a relaxed cut.',
  Accessories: 'Everyday carry, built to take a beating.',
};

/**
 * Deterministic pseudo-random generator.
 *
 * A seeded LCG rather than `Math.random` so the dataset is reproducible: the same
 * COUNT always produces the same catalog. That matters because benchmark numbers
 * are only comparable across runs if the data is identical, and a flaky test on
 * random data is impossible to debug.
 */
function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export async function seed(db: Db, count: number): Promise<void> {
  const random = makeRandom(42);
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;

  // Batched multi-row INSERT. One statement per row would mean `count` round trips;
  // at 200,000 rows that is the difference between seconds and many minutes. 1,000
  // is a deliberate ceiling — Postgres has a 65,535 bind-parameter limit, and at 11
  // parameters per row a larger batch would exceed it.
  const BATCH = 1000;
  const COLUMNS = 11;

  const startedAt = Date.now();
  let inserted = 0;

  for (let offset = 0; offset < count; offset += BATCH) {
    const rows = Math.min(BATCH, count - offset);
    const values: unknown[] = [];
    const placeholders: string[] = [];

    for (let i = 0; i < rows; i += 1) {
      const n = offset + i;

      // One draw for the whole family, so brand, category, line and price band
      // stay consistent with each other.
      const family = pick(FAMILIES);
      const colourway = pick(COLOURWAYS);
      const size = pick(SIZES);

      // Skewed toward the low end of the band, as a real catalog is: many
      // affordable items, few premium. A uniform distribution would make every
      // price-range filter equally selective and hide how the index behaves.
      const [low, high] = PRICE_BANDS[family.tier];
      const skewed = Math.min(random(), random());
      const rupees = Math.round((low + skewed * (high - low)) / 100) * 100 - 5;
      const priceMinor = Math.max(low, rupees) * 100;

      // ~8% out of stock, so `inStockOnly` filters something.
      const stock = random() < 0.08 ? 0 : Math.floor(random() * 200);
      // ~5% not active, so the default status filter is doing visible work.
      const status = random() < 0.05 ? (random() < 0.5 ? 'draft' : 'archived') : 'active';

      const slug = family.line
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

      const base = i * COLUMNS;
      placeholders.push(
        `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11})`,
      );

      values.push(
        randomUUID(),
        // `n` guarantees uniqueness across the whole run without a lookup.
        `${slug}-${String(n).padStart(6, '0')}`,
        `${family.line} '${colourway}'`,
        `${family.line} in ${colourway}. ${CATEGORY_BLURB[family.category] ?? ''}`.trim(),
        family.brand,
        family.category,
        priceMinor,
        'INR',
        stock,
        status,
        JSON.stringify({ colourway, size, tier: family.tier, generated: true }),
      );
    }

    await db.query(
      `INSERT INTO products
         (id, sku, name, description, brand, category, price_minor, currency, stock, status, attributes)
       VALUES ${placeholders.join(',')}
       ON CONFLICT DO NOTHING`,
      values,
    );

    inserted += rows;
    if (inserted % 25_000 === 0 || inserted === count) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(
        JSON.stringify({
          level: 'info',
          msg: 'seeding',
          inserted,
          of: count,
          elapsedSeconds: elapsed,
        }),
      );
    }
  }

  // Without fresh statistics the planner works from defaults and can pick a
  // sequential scan over a perfectly good index. Bulk loads must always be
  // followed by ANALYZE.
  await db.query('ANALYZE products');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const count = Number(process.env.COUNT ?? 200_000);
  const { db, driver } = await createDbFromEnv();

  await migrate(db);
  const before = await db.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM products');

  if (Number(before.rows[0]?.count ?? 0) >= count) {
    console.log(
      JSON.stringify({ level: 'info', msg: 'already seeded', products: before.rows[0]?.count }),
    );
  } else {
    console.log(JSON.stringify({ level: 'info', msg: 'seeding', driver, target: count }));
    await seed(db, count);
  }

  const after = await db.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM products');
  console.log(
    JSON.stringify({ level: 'info', msg: 'seed complete', products: after.rows[0]?.count }),
  );
  await db.close();
}
