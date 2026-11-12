import { memo } from "react";
import { Text, View } from "react-native";
import { getAvatarTone, getInitials } from "./contactDisplay";

type TContactAvatarProps = {
  label: string;
  size?: number;
};

const ContactAvatar = memo(function ContactAvatar({
  label,
  size = 40,
}: TContactAvatarProps) {
  const tone = getAvatarTone(label);
  return (
    <View
      className="items-center justify-center rounded-full"
      style={{ width: size, height: size, backgroundColor: tone.bg }}
    >
      <Text
        className="font-semibold"
        style={{ color: tone.fg, fontSize: Math.round(size * 0.34) }}
      >
        {getInitials(label)}
      </Text>
    </View>
  );
});

export default ContactAvatar;
