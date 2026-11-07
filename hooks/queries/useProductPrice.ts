import { useCallback } from "react";
import {
  formatProductPrice,
  priceFallbackText,
} from "@/constants/configs/productPayment";
import { useAppConfig, useProductPaymentMode } from "./useProductPaymentMode";

/**
 * The one way a component shows a product price: USD in TOKEN mode, points in
 * POINTS mode. The rate comes from `GET /app-config`. `formatPrice` gives null
 * without one, for places that hide the price; `priceText` always gives
 * something to show.
 */
export function useProductPrice() {
  const mode = useProductPaymentMode();
  const { data, isPending } = useAppConfig();
  const idrPerUsd = data?.productPayment?.idrPerUsd ?? null;

  const formatPrice = useCallback(
    (
      raw: string | number | null | undefined,
      options?: { compact?: boolean },
    ) => formatProductPrice(raw, mode, { ...options, idrPerUsd }),
    [mode, idrPerUsd],
  );

  const priceText = useCallback(
    (
      raw: string | number | null | undefined,
      options?: { compact?: boolean },
    ) => formatPrice(raw, options) ?? priceFallbackText(isPending),
    [formatPrice, isPending],
  );

  return { mode, idrPerUsd, formatPrice, priceText };
}
