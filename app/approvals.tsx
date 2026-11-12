// TWV-2026-009 — One-tap revoke screen for outstanding ERC-20 / 721 /
// 1155 approvals. Listed via the existing indexer query; revoke txs go
// through the same DappBridge approval spine the dApp browser uses, so
// the user sees the standard signer sheet (and gets the red banner from
// EvmTransactionSheet for `setApprovalForAll(false)` even though the
// origin is the wallet itself).
//
// `app/settings/approvals.tsx` was the path the task spec named, but
// this codebase keeps routes flat under `app/`; renamed accordingly.

import { Stack } from "expo-router";
import React, { useCallback } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { encodeFunctionData, parseAbiItem } from "viem";
import { useTokenApprovalsQuery } from "@/hooks/queries/useTokenApprovals";
import { useWallet } from "@/hooks/useWallet";
import { goBackOrHome } from "@/lib/navigation/goBackOrHome";
import { getDappBridge } from "@/services/bridge/DappBridge";
import type { TokenApproval } from "@/services/indexer/types";
import { getEvmChainId } from "@/services/walletKit/chainInfo";
import { truncateAddress } from "@/utils/walletUtils";

const APPROVE_ABI = parseAbiItem(
  "function approve(address spender, uint256 amount)",
);
const SET_APPROVAL_FOR_ALL_ABI = parseAbiItem(
  "function setApprovalForAll(address operator, bool approved)",
);

function buildRevokeData(approval: TokenApproval): `0x${string}` {
  if (approval.tokenType === "ERC-20") {
    return encodeFunctionData({
      abi: [APPROVE_ABI],
      args: [approval.spender as `0x${string}`, 0n],
    });
  }
  // ERC-721 / ERC-1155 — operator-set approvals revoke via setApprovalForAll(false).
  return encodeFunctionData({
    abi: [SET_APPROVAL_FOR_ALL_ABI],
    args: [approval.spender as `0x${string}`, false],
  });
}

export default function ApprovalsScreen(): React.ReactElement {
  const { activeWallet, activeChain } = useWallet();
  const chainId = getEvmChainId(activeChain);
  const { data, isLoading, refetch, isRefetching } = useTokenApprovalsQuery(
    activeWallet?.address,
    chainId ?? 1,
  );

  const handleRevoke = useCallback(
    async (approval: TokenApproval) => {
      const bridge = getDappBridge();
      if (!bridge || !activeWallet || !chainId) return;
      const data = buildRevokeData(approval);
      await bridge.submitAgentIntent({
        id: `revoke-${approval.contractAddress}-${approval.spender}-${Date.now()}`,
        namespace: "eip155",
        kind: "sendTransaction",
        origin: { url: "wallet://approvals" },
        wallet: activeWallet,
        payload: {
          type: 2,
          to: approval.contractAddress as `0x${string}`,
          from: activeWallet.address as `0x${string}`,
          value: 0n,
          data,
          chainId,
        },
        createdAt: Date.now(),
      });
      // Note: do NOT optimistically remove the row. Revoke is "done"
      // only when the on-chain tx is mined; the next refetch picks it
      // up via the indexer.
    },
    [activeWallet, chainId],
  );

  const renderRow = useCallback(
    ({ item }: { item: TokenApproval }) => (
      <View className="bg-white border border-gray-200 rounded-xl p-3 mb-2">
        <Text className="text-xs text-gray-500">
          {item.tokenType}
          {item.isApprovalForAll ? " · ApprovalForAll" : ""}
        </Text>
        <Text className="text-sm text-gray-900 mt-0.5" selectable>
          Token:{" "}
          {truncateAddress({ address: item.contractAddress, preset: "medium" })}
        </Text>
        <Text className="text-sm text-gray-900 mt-0.5" selectable>
          Spender:{" "}
          {item.spenderLabel
            ? `${item.spenderLabel} (${truncateAddress({ address: item.spender })})`
            : truncateAddress({ address: item.spender, preset: "medium" })}
        </Text>
        <Text className="text-xs text-gray-700 mt-0.5">
          Allowance:{" "}
          {item.allowance === "unlimited"
            ? "Unlimited ⚠️"
            : item.allowance.toString()}
        </Text>
        <Pressable
          onPress={() => void handleRevoke(item)}
          className="mt-3 bg-red-600 py-2 rounded-full items-center"
          accessibilityLabel={`Revoke approval for ${item.spender}`}
        >
          <Text className="text-white font-semibold text-sm">Revoke</Text>
        </Pressable>
      </View>
    ),
    [handleRevoke],
  );

  return (
    <SafeAreaView className="flex-1 bg-gray-50" edges={["top"]}>
      <Stack.Screen options={{ title: "Approvals" }} />
      <View className="px-4 pt-2 pb-3">
        <Text className="text-lg font-semibold text-gray-900">
          Outstanding approvals
        </Text>
        <Text className="text-xs text-gray-600 mt-0.5">
          Each row is a contract that can move your tokens or NFTs. Revoke
          anything you no longer use — drainers exploit forgotten approvals.
        </Text>
      </View>
      {isLoading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : (
        <FlatList
          contentContainerStyle={{ padding: 12 }}
          data={data ?? []}
          keyExtractor={(it) => `${it.contractAddress}-${it.spender}`}
          renderItem={renderRow}
          ListEmptyComponent={
            <View className="items-center mt-12">
              <Text className="text-sm text-gray-600">
                No outstanding approvals on this chain.
              </Text>
              <Pressable
                onPress={goBackOrHome}
                className="mt-4 px-4 py-2 rounded-full border border-gray-300"
              >
                <Text className="text-sm text-gray-800">Go back</Text>
              </Pressable>
            </View>
          }
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={() => void refetch()}
            />
          }
        />
      )}
    </SafeAreaView>
  );
}
