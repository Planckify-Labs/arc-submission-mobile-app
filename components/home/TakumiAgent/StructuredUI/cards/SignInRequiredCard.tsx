/**
 * The card for a tool result `{ status: "failed", error:
 * "authentication_required" }`: the wallet has no TakumiPay session, so a
 * retry cannot work and the only way forward is signing in.
 *
 * Inside the agent chat the sign-in runs as sheets over the chat
 * (`inlineSignIn`); anywhere without that host it opens `/auth`. Once
 * signed in, a live card can hand the conversation back to the agent.
 */

import { Check, LogIn } from "lucide-react-native";
import { memo, useState } from "react";
import { ActivityIndicator, Text, TouchableOpacity, View } from "react-native";
import { useGoToAuth } from "@/hooks/useGoToAuth";
import { inlineSignIn } from "@/services/auth/inlineSignIn";

const BRAND_RED = "#c71c4b";
const SUCCESS_GREEN = "#059669";

export const AUTH_REQUIRED = "authentication_required";

/** What the chat says for the user once they are signed in. */
export const SIGNED_IN_PROMPT = "I'm signed in now. Please continue.";

/**
 * `onSignedIn` for a card: only a live conversation continues on its
 * own; a historical card just signs in.
 */
export function continueAfterSignIn(
  mode: "live" | "historical" | undefined,
  onUserPrompt: ((prompt: string) => void) | undefined,
): (() => void) | undefined {
  return mode === "live" && onUserPrompt
    ? () => onUserPrompt(SIGNED_IN_PROMPT)
    : undefined;
}

type Phase = "idle" | "signing" | "signed_in" | "failed";

function SignInRequiredCard({
  title,
  body,
  onSignedIn,
}: {
  title: string;
  body: string;
  onSignedIn?: () => void;
}) {
  const { navigatingToAuth, goToAuth } = useGoToAuth();
  const [phase, setPhase] = useState<Phase>("idle");

  const signIn = async () => {
    if (!inlineSignIn.isAvailable()) {
      void goToAuth();
      return;
    }
    setPhase("signing");
    const result = await inlineSignIn.request();
    if (result === "signed_in") {
      setPhase("signed_in");
      onSignedIn?.();
    } else {
      setPhase(result === "failed" ? "failed" : "idle");
    }
  };

  if (phase === "signed_in") {
    return (
      <View className="my-1.5 flex-row items-center gap-2 rounded-2xl border border-light-matte-black/10 bg-white px-3.5 py-3">
        <Check size={16} color={SUCCESS_GREEN} />
        <Text className="text-sm font-semibold text-light-matte-black">
          You&apos;re signed in
        </Text>
      </View>
    );
  }

  const busy = phase === "signing" || navigatingToAuth;
  return (
    <View className="my-1.5 rounded-2xl border border-light-matte-black/10 bg-white px-3.5 py-4">
      <View className="flex-row items-center gap-2 mb-2">
        <View className="w-8 h-8 rounded-full bg-light-primary-red/10 items-center justify-center">
          <LogIn size={16} color={BRAND_RED} />
        </View>
        <Text className="text-sm font-semibold text-light-matte-black">
          {title}
        </Text>
      </View>
      <Text className="text-sm text-light-matte-black/70 mb-3">{body}</Text>
      {phase === "failed" ? (
        <Text className="text-xs font-medium text-light-primary-red mb-3">
          We couldn&apos;t sign you in. Please try again.
        </Text>
      ) : null}
      <TouchableOpacity
        disabled={busy}
        onPress={() => void signIn()}
        className={`rounded-full px-5 py-2.5 self-start flex-row items-center gap-2 ${
          busy ? "bg-light-primary-red/60" : "bg-light-primary-red"
        }`}
      >
        {busy ? <ActivityIndicator size="small" color="#ffffff" /> : null}
        <Text className="text-white font-semibold text-sm">
          {phase === "signing"
            ? "Signing in…"
            : navigatingToAuth
              ? "Opening sign-in…"
              : "Sign in"}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

export default memo(SignInRequiredCard);
