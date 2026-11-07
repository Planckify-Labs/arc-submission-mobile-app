import { useAppConfig } from "@/hooks/queries/useProductPaymentMode";
import { parseMinRemainderUsd } from "@/services/productPay/planPoints";

/**
 * Smallest token remainder (USD) a points + tokens purchase may leave, from
 * `GET /app-config` (same cached query as the payment mode). 0.3 only when
 * the API does not send it.
 */
export function useMinTokenRemainderUsd(): number {
  const { data } = useAppConfig();
  const raw = (
    data?.productPayment as { minTokenRemainderUsd?: unknown } | undefined
  )?.minTokenRemainderUsd;
  return parseMinRemainderUsd(raw);
}
