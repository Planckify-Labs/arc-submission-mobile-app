import { publicApi } from "@/constants/configs/ky";
import { fetchList } from "../utils/api-helpers";

export interface TBlockchain {
  id: string;
  name: string;
  chainId: number | null;
  /** Stable slug for non-EVM rows, e.g. `solana-devnet`. */
  chainSlug?: string | null;
  rpcUrl: string;
  blockExplorer: string;
  isEVM: boolean;
  isActive: boolean;
  isTestnet: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TSmartContract {
  id: string;
  name: string;
  /** Contract category, e.g. "payment" (takumi_pay), "gateway", "protocol". */
  type: string;
  version: number;
  blockchain: TBlockchain;
  blockchainId: string;
  address: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type TSmartContractListResponse = TSmartContract[];

export const smartContractApi = {
  getSmartContractList: () =>
    fetchList<TSmartContractListResponse>(
      publicApi,
      "smart-contracts",
      "Failed to fetch smart contract list",
    ),

  getSmartContractsByChain: async (chainId: number) => {
    try {
      return await publicApi
        .get(`smart-contracts/chain/${chainId}`)
        .json<TSmartContract>();
    } catch (error: any) {
      if (error?.response?.status === 404) return null;
      console.error("Failed to fetch smart contract by chain:", error);
      throw error;
    }
  },

  searchSmartContracts: async (params: {
    name?: string;
    type?: string;
    blockchainId?: string;
    chainId?: number;
    isActive?: boolean;
    isBlockchainEVM?: boolean;
  }) => {
    const searchParams = new URLSearchParams();
    if (params.name) searchParams.set("name", params.name);
    if (params.type) searchParams.set("type", params.type);
    if (params.blockchainId)
      searchParams.set("blockchainId", params.blockchainId);
    if (params.chainId != null)
      searchParams.set("chainId", String(params.chainId));
    if (params.isActive != null)
      searchParams.set("isActive", String(params.isActive));
    if (params.isBlockchainEVM != null)
      searchParams.set("isBlockchainEVM", String(params.isBlockchainEVM));
    try {
      return await publicApi
        .get(`smart-contracts/search?${searchParams}`)
        .json<TSmartContract[]>();
    } catch (error: any) {
      if (error?.response?.status === 404) return [];
      console.error("Failed to search smart contracts:", error);
      throw error;
    }
  },
};
