import { ShoppingBag, Sparkles, Wallet } from "lucide-react-native";
import type { TProductPaymentMode } from "@/constants/configs/productPayment";

/**
 * Agent onboarding slides. Only the copy that names the payment model
 * (slide 1 description, slide 3) varies with the mode.
 */
export function getOnboardingSlideData(mode: TProductPaymentMode) {
  const isToken = mode === "TOKEN";
  return [
    {
      icon: Sparkles,
      iconColor: "#c71c4b",
      iconBgColor: "#fef2f2",
      accentColor: "#c71c4b",
      title: "Meet Your AI Wallet Agent",
      description: isToken
        ? "Your personal assistant for managing crypto and shopping through natural conversations."
        : "Your personal assistant for managing crypto and redeeming points through natural conversations.",
      features: [
        "Natural language transaction execution",
        "Optional wallet access, you decide what the agent can do",
        "Multi-chain blockchain support",
      ],
    },
    {
      icon: Wallet,
      iconColor: "#059669",
      iconBgColor: "#ecfdf5",
      accentColor: "#059669",
      title: "On-Chain Actions",
      description:
        "Send tokens, check balances, and monitor gas fees across multiple chains.",
      features: [
        "Native tokens: ETH, MATIC, BNB",
        "ERC-20: USDT, USDC, DAI & more",
        "NFT transfers (ERC-721)",
        "Real-time gas estimates",
      ],
    },
    {
      icon: ShoppingBag,
      iconColor: "#7c3aed",
      iconBgColor: "#faf5ff",
      accentColor: "#7c3aed",
      title: isToken ? "Shop via Chat" : "Redeem via Chat",
      description: isToken
        ? "Browse products in your conversation, then tap one to pay at checkout."
        : "Explore services and redeem your points directly in your conversation.",
      features: [
        "Full product catalog access",
        "Filter by category & price",
        isToken ? "Tap a product to pay" : "One-command redemption",
      ],
    },
  ];
}
