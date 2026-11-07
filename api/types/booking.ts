export type TBooking = {
  id: string;
  walletAddress: string;
  product: {
    id: string;
    name: string;
    variant: {
      id: string;
      name: string;
      variantCode: string;
    };
    price: {
      amount: number;
      currency: string;
    };
  };
  payment: {
    token: {
      symbol: string;
      address: string;
      amount: string;
      blockchainId: string;
      blockchainName: string;
    };
    /**
     * Picked by the server when the booking is created. This `id` is the
     * one the contract call must carry, never one fetched earlier.
     */
    /** Points held for this booking, a decimal string; "0" or absent when none. */
    pointsApplied?: string;
    exchangeRate: {
      id: number;
      rate: number;
      lockedAt: string;
    };
  };
  status: "PENDING" | "EXPIRED" | "EXECUTED" | "CANCELLED";
  createdAt: string;
  expiresAt: string;
  /** Present once the booking is EXECUTED. */
  executedAt?: string;
};

export type CustomerInfoItem = {
  key: string;
  value: string;
};

export type TBookingCreateRequest = {
  walletAddress: string;
  productVariantId: string;
  productPriceId: string;
  payment: {
    tokenAddress: string;
    blockchainId: string;
    /** Optional and ignored: the server picks the rate. */
    exchangeRateId?: number;
  };
  customerInfo?: CustomerInfoItem[];
  /** Spend points toward the price. The server picks the amount. */
  usePoints?: boolean;
};

export type TBookingListResponse = TBooking[];
