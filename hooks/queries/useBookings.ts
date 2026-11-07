import { useMutation, useQuery } from "@tanstack/react-query";
import { bookingApi } from "@/api/endpoints/bookings";
import type { TBooking, TBookingCreateRequest } from "@/api/types/booking";

interface TUseBookingsOptions {
  walletAddress?: string;
  productId?: string;
  status?: TBooking["status"];
  take?: number;
  cursor?: string;
}

export const useBookings = (options?: TUseBookingsOptions) => {
  return useQuery<TBooking[]>({
    queryKey: ["bookings", options],
    queryFn: async () => {
      try {
        const response = await bookingApi.getBookingList();
        return response;
      } catch (error) {
        if (__DEV__) console.warn("API Error:", error);
        throw error;
      }
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
};

export const useLatestBooking = (walletAddress: string) => {
  return useQuery<TBooking | null>({
    queryKey: ["latestBooking", walletAddress],
    queryFn: async () => {
      try {
        const response = await bookingApi.getLatestBooking(walletAddress);
        return response;
      } catch (error) {
        if (__DEV__) console.warn("API Error:", error);
        throw error;
      }
    },
    staleTime: 30 * 1000,
    gcTime: 5 * 60 * 1000,
  });
};

export const useCreateBooking = () => {
  return useMutation({
    mutationFn: async (data: TBookingCreateRequest) => {
      try {
        const response = await bookingApi.createBooking({
          walletAddress: data.walletAddress,
          productVariantId: data.productVariantId,
          productPriceId: data.productPriceId,
          payment: {
            tokenAddress: data.payment.tokenAddress,
            blockchainId: data.payment.blockchainId,
            exchangeRateId: data.payment.exchangeRateId,
          },
          customerInfo: data.customerInfo,
          usePoints: data.usePoints,
        });
        return response;
      } catch (error) {
        if (__DEV__) console.warn("API Error:", error);
        throw error;
      }
    },
  });
};
