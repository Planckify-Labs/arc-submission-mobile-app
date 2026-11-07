import { api } from "@/constants/configs/ky";
import type {
  TPurchaseCreateRequest,
  TPurchaseResponse,
} from "../types/purchase";

export const purchaseApi = {
  createPurchase: async (data: TPurchaseCreateRequest) => {
    try {
      const response = await api
        .post("purchases", { json: data })
        .json<TPurchaseResponse>();
      return response;
    } catch (error) {
      if (__DEV__) console.warn("Failed to create purchase:", error);
      throw error;
    }
  },

  getPurchaseById: async (id: string) => {
    try {
      const response = await api
        .get(`purchases/${id}`)
        .json<TPurchaseResponse>();
      return response;
    } catch (error) {
      if (__DEV__) console.warn("Failed to fetch purchase by ID:", error);
      throw error;
    }
  },

  getPurchaseByRefId: async (refId: string) => {
    try {
      const response = await api
        .get(`purchases/${refId}`)
        .json<TPurchaseResponse>();
      return response;
    } catch (error) {
      if (__DEV__) console.warn("Failed to fetch purchase:", error);
      throw error;
    }
  },

  getPurchasesByWallet: async (walletAddress: string) => {
    try {
      const response = await api
        .get(`purchases/wallet/${walletAddress}`)
        .json<TPurchaseResponse[]>();
      return response;
    } catch (error) {
      if (__DEV__) console.warn("Failed to fetch purchases for wallet:", error);
      throw error;
    }
  },
};
