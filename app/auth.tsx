import { router } from "expo-router";
import { ArrowLeft, Shield, Wallet2 } from "lucide-react-native";
import { Image, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import LoadinngSpinnerPopup from "@/components/common/LoadinngSpinnerPopup";
import PinConfirmationModal from "@/components/common/PinConfirmationModal";
import SignMessageModal from "@/components/common/SignMessageModal";
import { useWalletSignInFlow } from "@/hooks/useWalletSignInFlow";
import { formatChainLabel } from "@/services/walletKit/chainInfo";

export default function AuthScreen() {
  const {
    activeWallet,
    activeChain,
    isWalletLoading,
    start: startAuthentication,
    statementModal,
    pinModal,
    loading,
  } = useWalletSignInFlow({
    // Back to the screen that asked for sign-in (every entry pushes
    // /auth); replacing with "/" stranded it under a second home.
    onSignedIn: () => {
      if (router.canGoBack()) router.back();
      else router.replace("/");
    },
  });
  const isLoading = loading.visible;

  const activeChainName = formatChainLabel(activeChain);

  return (
    <SafeAreaView className="flex-1 bg-light-main-container">
      <View className="flex-row items-center justify-between p-4 pb-2">
        <TouchableOpacity
          onPress={() => router.back()}
          className="w-11 h-11 items-center justify-center rounded-2xl bg-light shadow-sm"
          activeOpacity={0.7}
          style={{
            shadowColor: "#000",
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.1,
            shadowRadius: 4,
            elevation: 3,
          }}
        >
          <ArrowLeft size={22} color="#20222c" strokeWidth={2} />
        </TouchableOpacity>

        <View className="flex-1 items-center">
          <Text className="text-lg font-bold text-light-matte-black">
            Almost There! 🎉
          </Text>
          <Text className="text-light-matte-black/60 text-sm">
            One quick step to secure your account
          </Text>
        </View>

        <View className="w-11" />
      </View>

      <ScrollView
        className="flex-1 px-4"
        contentContainerStyle={{ paddingBottom: 20 }}
        showsVerticalScrollIndicator={false}
      >
        <View className="items-center py-8 mb-6">
          <View className="relative mb-6">
            <View className="bg-light-primary-red/5 w-28 h-28 rounded-3xl items-center justify-center">
              <View className="bg-light-primary-red/10 w-24 h-24 rounded-2xl items-center justify-center">
                <View className="bg-light w-20 h-20 rounded-xl items-center justify-center shadow-sm">
                  <Image
                    source={require("@/assets/images/takumipay-logo.png")}
                    style={{ width: 50, height: 50 }}
                    resizeMode="contain"
                  />
                </View>
              </View>
            </View>
            <View className="absolute -top-2 -right-2 w-4 h-4 bg-light-primary-red rounded-full" />
            <View className="absolute -bottom-1 -left-1 w-3 h-3 bg-light-primary-red/60 rounded-full" />
          </View>

          <Text className="text-light-matte-black text-2xl font-bold mb-3 text-center">
            Secure Your Access
          </Text>

          <Text className="text-light-matte-black/60 text-center text-base leading-6 max-w-80">
            Sign a quick message to unlock your wallet safely and securely ✨
          </Text>
        </View>

        <View className="bg-light rounded-3xl p-6 mb-6 shadow-sm">
          <View className="flex-row items-center mb-4">
            <View className="bg-light-primary-red/10 p-3 rounded-2xl mr-4">
              <Wallet2 color="#c71c4b" size={24} strokeWidth={2} />
            </View>
            <View className="flex-1">
              <Text className="text-light-matte-black font-bold text-lg">
                {activeWallet?.name || "My Wallet"}
              </Text>
              <Text className="text-light-matte-black/50 text-sm">
                Connected and ready
              </Text>
            </View>
          </View>

          <View className="bg-light-main-container p-4 rounded-2xl mb-6">
            <View className="flex-row items-center justify-between mb-3">
              <Text className="text-light-matte-black/70 text-sm">
                Wallet Address
              </Text>
              <View className="bg-light-primary-red/10 px-2 py-1 rounded-full">
                <Text className="text-light-primary-red text-xs font-medium">
                  Active
                </Text>
              </View>
            </View>
            <Text className="text-light-matte-black font-mono text-sm mb-3">
              {activeWallet?.address
                ? `${activeWallet.address.substring(0, 12)}...${activeWallet.address.substring(
                    activeWallet.address.length - 8,
                  )}`
                : "No wallet selected"}
            </Text>
            <View className="flex-row items-center">
              <View className="w-2 h-2 bg-green-500 rounded-full mr-2" />
              <Text className="text-light-matte-black/60 text-xs">
                {activeChainName || "Unknown Network"}
              </Text>
            </View>
          </View>

          {!isLoading ? (
            <TouchableOpacity
              className={`py-4 rounded-2xl items-center flex-row justify-center gap-3 ${isWalletLoading || !activeWallet?.address ? "bg-light-primary-red/50" : "bg-light-primary-red"}`}
              onPress={startAuthentication}
              activeOpacity={0.8}
              disabled={isWalletLoading || !activeWallet?.address}
              style={{
                shadowColor: "#c71c4b",
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.15,
                shadowRadius: 12,
                elevation: 8,
              }}
            >
              <Shield color="#ffffff" size={20} strokeWidth={2} />
              <Text className="text-white font-bold text-base">
                {isWalletLoading ? "Loading Wallet..." : "Sign & Continue"}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>

        <View className="bg-light rounded-3xl p-4 shadow-sm">
          <View className="flex-row items-center justify-center">
            <Shield color="#059669" size={16} strokeWidth={2} />
            <Text className="text-light-matte-black/60 text-sm ml-2">
              Secure • No gas fees • Your keys stay safe
            </Text>
          </View>
        </View>
      </ScrollView>

      <SignMessageModal {...statementModal} />

      <PinConfirmationModal {...pinModal} title="Confirm Authentication" />

      <LoadinngSpinnerPopup
        visible={loading.visible}
        title="Authenticating"
        message={loading.message}
      />
    </SafeAreaView>
  );
}
