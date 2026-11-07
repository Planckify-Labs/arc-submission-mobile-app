import PointsCheckout from "@/components/checkout/PointsCheckout";
import TokenCheckout from "@/components/checkout/TokenCheckout";
import { useProductPaymentMode } from "@/hooks/queries/useProductPaymentMode";

/**
 * Product checkout. What we OFFER follows `PRODUCT_PAYMENT_MODE`; the points
 * flow itself stays reachable from the token screen so balances and refunds
 * are never stranded.
 */
export default function PaymentScreen() {
  const mode = useProductPaymentMode();
  return mode === "POINTS" ? <PointsCheckout /> : <TokenCheckout />;
}
