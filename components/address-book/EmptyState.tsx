import { BookUser } from "lucide-react-native";
import { Text, View } from "react-native";

type EmptyStateProps = {
  isSearching: boolean;
};

export default function EmptyState({ isSearching }: EmptyStateProps) {
  return (
    <View className="flex-1 items-center justify-center px-10 pt-[60px]">
      <View className="w-[72px] h-[72px] rounded-[22px] bg-light-primary-red/10 items-center justify-center mb-4">
        <BookUser size={32} color="#c71c4b" />
      </View>
      <Text className="text-lg font-bold text-light-matte-black text-center mb-2">
        {isSearching ? "No results found" : "No contacts yet"}
      </Text>
      <Text className="text-sm leading-5 text-[#5f616b] text-center">
        {isSearching
          ? "Try a different name or address"
          : "Tap Add to save a wallet address\nwith a friendly name"}
      </Text>
    </View>
  );
}
