// Explicit allowlist, not a passthrough of the raw route: expo-router's
// usePathname() resolves dynamic segments to their real values (e.g. a tx
// hash or purchase id inside "/pay-merchant/receipt/abc123"), which must
// never be sent verbatim. Only the top-level segment is looked up here, and
// only funnel-relevant flows are mapped — auth/onboarding/settings screens
// are deliberately left out (return null → not tracked), same spirit as
// excluding sign-in/sign-up from the event catalog.
const SCREEN_NAMES: Record<string, string> = {
  "": "Home",
  index: "Home",
  send: "Send",
  "send-success": "Send Success",
  deposit: "Deposit",
  "add-funds": "Add Funds",
  withdraw: "Withdraw",
  payment: "Bill Payment",
  "pay-merchant": "Merchant Payment",
  "pay-x402": "x402 Payment",
  "pulsa-data": "Mobile Data Top-up",
  "purchase-item": "Purchase Item",
  "view-all-item": "Browse Items",
  "scan-to-pay": "Scan To Pay",
  "dapps-browser": "dApps Browser",
  activities: "Activity List",
  "activity-detail": "Activity Detail",
  wallet: "Wallet",
  approvals: "Approvals",
  merchant: "Merchant",
  strategies: "Strategies",
};

export function resolveScreenName(pathname: string): string | null {
  const firstSegment = pathname.split("/").filter(Boolean)[0] ?? "";
  return SCREEN_NAMES[firstSegment] ?? null;
}
