import { publicApi } from "@/constants/configs/ky";

export type TAppConfig = {
  productPayment?: { mode?: string; idrPerUsd?: number | null };
};

export const appConfigApi = {
  get: () => publicApi.get("app-config").json<TAppConfig>(),
};
