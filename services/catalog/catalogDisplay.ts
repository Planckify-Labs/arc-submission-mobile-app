/**
 * Shared shaping for redemption-catalog search results.
 *
 * Both the agent executor (`search_redemption_catalog`, page 0) and the
 * `RedemptionCatalogCard` (client-side next/prev paging) turn raw
 * `TProductSearchResult` rows into the same compact display shape, so a
 * page fetched by the card looks identical to the page the agent returned.
 * Keep this the single source of truth for that mapping.
 */

import type { TProductSearchResult } from "@/api/endpoints/products";
import type { TProductVariant } from "@/api/types/product";
import { usdPriceString } from "./usdPrice";

export type TCatalogDisplayProduct = {
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  code: string;
  category_id: string;
  category: { id: string; name: string } | null;
  /** Lowest active variant points cost ("from X pts"); null if unpriced. */
  starting_points: string | null;
  /** Same price in USD ("3.21"); omitted when no rate is available. */
  starting_price_usd?: string;
  input_type: string | null;
};

/**
 * Lowest active points cost across a product's variants. Returns null when
 * the search payload carried no active variant prices.
 */
export function startingPoints(
  variants: TProductVariant[] | undefined,
): string | null {
  if (!variants?.length) return null;
  let min: number | null = null;
  for (const v of variants) {
    if (v.isActive === false) continue;
    for (const p of v.ProductPrice ?? []) {
      if (p.isActive === false) continue;
      const n = Number(p.sellPrice);
      if (Number.isFinite(n) && (min === null || n < min)) min = n;
    }
  }
  return min === null ? null : String(min);
}

/** Format a raw points string ("2300") as "2,300 pts"; null-safe. */
export function formatPoints(raw?: string | null): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return `${n.toLocaleString("en-US")} pts`;
}

export function toCatalogDisplayProducts(
  raw: TProductSearchResult[],
  idrPerUsd?: number | null,
): TCatalogDisplayProduct[] {
  return raw.map((p) => {
    const startingPoints_ = startingPoints(p.variants);
    const usd = usdPriceString(startingPoints_, idrPerUsd);
    return {
      id: p.id,
      name: p.name,
      description: p.description ?? null,
      image_url: p.imageUrl ?? null,
      code: p.code,
      category_id: p.categoryId,
      category: p.category
        ? { id: p.category.id, name: p.category.name }
        : null,
      starting_points: startingPoints_,
      ...(usd ? { starting_price_usd: usd } : {}),
      input_type: p.inputType ?? null,
    };
  });
}
