import { useQuery } from "@tanstack/react-query";
import { appConfigApi } from "@/api/endpoints/appConfig";
import {
  DEFAULT_PRODUCT_PAYMENT_MODE,
  parseProductPaymentMode,
  type TProductPaymentMode,
} from "@/constants/configs/productPayment";
import { appConfigQueryKeys } from "@/constants/queryKeys/appConfigQueryKeys";

export function useAppConfig() {
  return useQuery({
    queryKey: appConfigQueryKeys.all,
    queryFn: appConfigApi.get,
    // Without a rate, prices can't render: never sit on that answer.
    staleTime: (query) =>
      query.state.data?.productPayment?.idrPerUsd ? 60 * 1000 : 0,
  });
}

/**
 * The live product payment mode. The query is persisted to disk like any other
 * server state, so a restart renders the last known mode straight away and the
 * default is only ever seen on a first launch with no API.
 */
export function useProductPaymentMode(): TProductPaymentMode {
  const { data } = useAppConfig();
  return (
    parseProductPaymentMode(data?.productPayment?.mode) ??
    DEFAULT_PRODUCT_PAYMENT_MODE
  );
}
