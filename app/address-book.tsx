import { useFocusEffect } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import {
  ArrowLeft,
  BookUser,
  Plus,
  Search,
  Shield,
  X,
} from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import type { TCreateAddressBookDto } from "@/api/types/addressBook";
import AddContactModal from "@/components/address-book/AddContactModal";
import AddressBookItem from "@/components/address-book/AddressBookItem";
import ContactActionsSheet from "@/components/address-book/ContactActionsSheet";
import EmptyState from "@/components/address-book/EmptyState";
import type { TAddressBookEntry } from "@/constants/types/addressBookTypes";
import { useIsAuthenticated } from "@/hooks/queries/useAuth";
import { useAddressBook } from "@/hooks/useAddressBook";
import { useWallet } from "@/hooks/useWallet";
import { getChainFamilyLabel } from "@/services/walletKit/chainInfo";

export default function AddressBook() {
  const { isAuthenticated, hadPreviousSession } = useIsAuthenticated();
  const { activeWallet } = useWallet();
  const chainFamily = getChainFamilyLabel(activeWallet?.namespace);
  // Send-screen-style yield hack for the sign-in CTA: flip the button to
  // a spinner, wait 100 ms so React commits + paints that frame, THEN
  // fire the navigation. Without the yield, the `router.push` triggers
  // an immediate mount of `/auth` that freezes the main thread through
  // the transition animation — the button press feels dead even though
  // we already set the pressed state.
  const [navigatingToAuth, setNavigatingToAuth] = useState(false);
  const goToAuth = useCallback(async () => {
    if (navigatingToAuth) return;
    setNavigatingToAuth(true);
    await new Promise((r) => setTimeout(r, 100));
    router.push("/auth");
  }, [navigatingToAuth]);
  // Reset the spinner when the user comes back to this screen — e.g.
  // they cancelled on `/auth`. Without this, the button stays in the
  // "Opening sign-in…" state forever until the screen unmounts.
  useFocusEffect(
    useCallback(() => {
      setNavigatingToAuth(false);
    }, []),
  );
  const {
    contacts,
    search,
    setSearch,
    add,
    update,
    remove,
    refetch,
    isAdding,
    isUpdating,
    addError,
  } = useAddressBook();
  const [showModal, setShowModal] = useState(false);
  const [editingEntry, setEditingEntry] = useState<TAddressBookEntry | null>(
    null,
  );
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const searchRef = useRef<TextInput>(null);
  const { bottom } = useSafeAreaInsets();
  const bottomOffset = Platform.OS === "ios" ? 0 : bottom > 0 ? bottom : 16;

  // Copy feedback is inline (the row / sheet button flips to "Copied" for a
  // moment) instead of a toast or an Alert the user has to dismiss.
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const handleCopy = useCallback(async (entry: TAddressBookEntry) => {
    await Clipboard.setStringAsync(entry.address);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    setCopiedId(entry.id);
    copiedTimer.current = setTimeout(() => setCopiedId(null), 1500);
  }, []);

  // Contact action sheet. `sheetEntry` outlives `sheetOpen` so the sheet keeps
  // its content through the close animation; follow-up actions that open
  // another modal (edit form, delete confirm) or navigate wait for the sheet
  // to finish closing, so two modals never animate at once.
  const [sheetEntry, setSheetEntry] = useState<TAddressBookEntry | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const afterSheetClose = useRef<(() => void) | null>(null);

  const handleOpenSheet = useCallback((entry: TAddressBookEntry) => {
    afterSheetClose.current = null;
    setSheetEntry(entry);
    setSheetOpen(true);
  }, []);

  const closeSheetThen = useCallback((action: () => void) => {
    afterSheetClose.current = action;
    setSheetOpen(false);
  }, []);

  const handleSheetClosed = useCallback(() => {
    setSheetEntry(null);
    const action = afterSheetClose.current;
    afterSheetClose.current = null;
    action?.();
  }, []);

  const handleSend = useCallback(() => {
    if (!sheetEntry) return;
    const recipientAddress = sheetEntry.address;
    closeSheetThen(() =>
      router.push({ pathname: "/send", params: { recipientAddress } }),
    );
  }, [sheetEntry, closeSheetThen]);

  const handleEdit = useCallback(() => {
    if (!sheetEntry) return;
    const entry = sheetEntry;
    closeSheetThen(() => {
      setEditingEntry(entry);
      setShowModal(true);
    });
  }, [sheetEntry, closeSheetThen]);

  const handleDelete = useCallback(() => {
    if (!sheetEntry) return;
    const { id } = sheetEntry;
    closeSheetThen(() =>
      Alert.alert(
        "Delete Contact",
        "Remove this contact from your address book?",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Delete", style: "destructive", onPress: () => remove(id) },
        ],
      ),
    );
  }, [sheetEntry, closeSheetThen, remove]);

  const handleCloseModal = useCallback(() => {
    setShowModal(false);
    setEditingEntry(null);
  }, []);

  const handleSave = useCallback(
    async (dto: TCreateAddressBookDto) => {
      if (editingEntry) {
        await update(editingEntry.id, dto);
      } else {
        await add(dto);
      }
      handleCloseModal();
    },
    [editingEntry, add, update, handleCloseModal],
  );

  const handleOpenAdd = useCallback(() => {
    setEditingEntry(null);
    setShowModal(true);
  }, []);

  const handleRefresh = useCallback(async () => {
    setIsManualRefreshing(true);
    await refetch();
    setIsManualRefreshing(false);
  }, [refetch]);

  const renderItem = useCallback(
    ({ item }: { item: TAddressBookEntry }) => (
      <AddressBookItem
        entry={item}
        copied={copiedId === item.id}
        onPress={handleOpenSheet}
        onCopy={handleCopy}
      />
    ),
    [copiedId, handleOpenSheet, handleCopy],
  );

  const keyExtractor = useCallback((item: TAddressBookEntry) => item.id, []);

  // Show sign-in prompt immediately for users who have never
  // authenticated. Previously this waited for `isAuthLoading === false`
  // too, which delayed the prompt while `useIsAuthenticated` did its
  // SecureStore cascade — users saw a flash of the "real" screen (which
  // fires auth'd contact queries that all fail) before the prompt
  // appeared. Since `hadPreviousSession` is the authoritative signal
  // for "user has ever had tokens on this wallet", we don't need to
  // wait for the loading state to resolve.
  if (isAuthenticated !== true && !hadPreviousSession) {
    return (
      <View className="flex-1">
        <SystemBars style="dark" />
        <SafeAreaView
          edges={["top"]}
          className="flex-1 bg-light-main-container"
        >
          {/* Header */}
          <View className="px-4 pt-2 pb-4">
            <View className="flex-row items-center gap-3">
              <Pressable
                onPress={() => router.back()}
                hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                className="w-9 h-9 rounded-xl bg-light items-center justify-center shadow-sm"
              >
                <ArrowLeft size={18} color="#c71c4b" />
              </Pressable>
              <Text className="text-light-matte-black text-2xl font-bold tracking-tight flex-1">
                Address Book
              </Text>
            </View>
          </View>

          {/* Sign-in prompt */}
          <View className="flex-1 items-center justify-center px-10">
            <View className="mb-8 relative items-center justify-center h-32">
              <View className="absolute w-28 h-28 bg-light-primary-red/5 rounded-full" />
              <View className="absolute w-20 h-20 bg-light-primary-red/10 rounded-full" />
              <View className="absolute -top-2 -left-8 w-3 h-3 bg-light-primary-red/30 rounded-full" />
              <View className="absolute top-4 -right-10 w-2 h-2 bg-light-primary-red/40 rounded-full" />
              <View className="absolute -bottom-2 left-6 w-2.5 h-2.5 bg-light-primary-red/25 rounded-full" />
              <View
                className="bg-white w-24 h-24 rounded-3xl items-center justify-center border-2 border-light-primary-red/20"
                style={{
                  shadowColor: "#c71c4b",
                  shadowOffset: { width: 0, height: 8 },
                  shadowOpacity: 0.15,
                  shadowRadius: 20,
                  elevation: 10,
                }}
              >
                <View className="absolute inset-2 bg-light-primary-red/5 rounded-2xl" />
                <BookUser size={40} color="#c71c4b" />
              </View>
              <View className="absolute -top-1 -right-6 w-5 h-5 bg-light-primary-red rounded-full border-[3px] border-light-main-container items-center justify-center">
                <View className="w-2 h-2 bg-white rounded-full" />
              </View>
            </View>

            <View className="items-center max-w-[280px] mb-8">
              <Text className="text-light-matte-black font-bold text-2xl mb-3 text-center">
                Sign in to access your Address Book
              </Text>
              <Text className="text-light-matte-black/45 text-center text-sm leading-6">
                Save and manage wallet addresses with friendly names. Sign in
                with {chainFamily} to get started.
              </Text>
            </View>

            <TouchableOpacity
              activeOpacity={0.8}
              onPress={goToAuth}
              disabled={navigatingToAuth}
              className={`py-4 px-8 rounded-2xl flex-row items-center gap-3 mb-6 ${
                navigatingToAuth
                  ? "bg-light-primary-red/80"
                  : "bg-light-primary-red"
              }`}
              style={{
                shadowColor: "#c71c4b",
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.2,
                shadowRadius: 12,
                elevation: 8,
              }}
            >
              {navigatingToAuth && (
                <ActivityIndicator size="small" color="#ffffff" />
              )}
              <Text className="text-white font-bold text-base">
                {navigatingToAuth
                  ? "Opening sign-in…"
                  : `Sign In With ${chainFamily}`}
              </Text>
            </TouchableOpacity>

            <View className="gap-2.5 w-full">
              <View className="flex-row items-center gap-3 px-3 py-2.5 rounded-xl bg-light">
                <View className="bg-light-primary-red/10 p-1.5 rounded-lg">
                  <Shield color="#c71c4b" size={14} strokeWidth={2.5} />
                </View>
                <Text className="text-light-matte-black/55 text-xs flex-1 font-medium">
                  Secure & gasless authentication
                </Text>
              </View>
              <View className="flex-row items-center gap-3 px-3 py-2.5 rounded-xl bg-light">
                <View className="bg-light-primary-red/10 p-1.5 rounded-lg">
                  <BookUser color="#c71c4b" size={14} strokeWidth={2.5} />
                </View>
                <Text className="text-light-matte-black/55 text-xs flex-1 font-medium">
                  Save addresses with friendly names
                </Text>
              </View>
            </View>
          </View>
        </SafeAreaView>
      </View>
    );
  }

  return (
    <View className="flex-1">
      <SystemBars style="dark" />
      <SafeAreaView
        edges={["top"]}
        className="flex-1 bg-light-main-container"
        style={{ paddingBottom: bottomOffset }}
      >
        {/* Header */}
        <View className="px-4 pt-2 pb-3">
          <View className="flex-row items-center gap-3">
            <Pressable
              onPress={() => router.back()}
              accessibilityRole="button"
              accessibilityLabel="Back"
              hitSlop={{ top: 4, right: 4, bottom: 4, left: 4 }}
              className="w-11 h-11 rounded-[14px] bg-light border border-[#e6e8ee] items-center justify-center"
            >
              <ArrowLeft size={18} color="#20222c" />
            </Pressable>
            <Text
              className="flex-1 text-light-matte-black text-[22px] font-bold tracking-tight"
              numberOfLines={1}
            >
              Address Book
            </Text>
            <Pressable
              onPress={handleOpenAdd}
              accessibilityRole="button"
              accessibilityLabel="Add contact"
              className="h-11 pl-3 pr-3.5 rounded-[14px] bg-light-primary-red flex-row items-center active:opacity-80"
            >
              <Plus size={18} color="white" strokeWidth={2.2} />
              <Text className="text-white text-sm font-semibold ml-1.5">
                Add
              </Text>
            </Pressable>
          </View>

          {/* Search bar */}
          <View
            className={`mt-4 h-[46px] flex-row items-center bg-light rounded-[14px] pl-3.5 pr-1.5 border ${
              search ? "border-light-primary-red" : "border-[#e6e8ee]"
            }`}
          >
            <Search size={16} color={search ? "#20222c" : "#6b6d76"} />
            <TextInput
              ref={searchRef}
              value={search}
              onChangeText={setSearch}
              placeholder="Search name, address or ENS"
              placeholderTextColor="#6b6d76"
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Search contacts"
              className="flex-1 ml-2.5 py-0 text-sm text-light-matte-black"
            />
            {!!search && (
              <Pressable
                onPress={() => setSearch("")}
                accessibilityRole="button"
                accessibilityLabel="Clear search"
                className="w-9 h-9 items-center justify-center"
              >
                <X size={16} color="#5f616b" />
              </Pressable>
            )}
          </View>
        </View>

        {/* List */}
        {/*
          Rows are plain views now (no reanimated entrance, no swipe
          gesture), but the tight window still keeps back-navigation
          teardown cheap on long contact lists.
        */}
        <FlatList
          data={contacts}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          extraData={copiedId}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            paddingTop: 4,
            paddingBottom: 24,
            flexGrow: 1,
          }}
          ListHeaderComponent={
            contacts.length > 0 ? (
              <Text className="px-5 pb-2 text-xs font-semibold uppercase tracking-wider text-[#5f616b]">
                {`${contacts.length} contact${contacts.length !== 1 ? "s" : ""}`}
              </Text>
            ) : null
          }
          ListEmptyComponent={<EmptyState isSearching={!!search} />}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          removeClippedSubviews
          initialNumToRender={8}
          maxToRenderPerBatch={6}
          windowSize={5}
          refreshControl={
            <RefreshControl
              refreshing={isManualRefreshing}
              onRefresh={handleRefresh}
              tintColor="#c71c4b"
              colors={["#c71c4b"]}
            />
          }
        />

        {contacts.length > 0 && (
          <View className="pb-2 items-center">
            <Text className="text-xs text-[#6b6d76]">
              Tap a contact to send, edit or delete
            </Text>
          </View>
        )}
      </SafeAreaView>

      <ContactActionsSheet
        visible={sheetOpen}
        entry={sheetEntry}
        copied={!!sheetEntry && copiedId === sheetEntry.id}
        onClose={() => setSheetOpen(false)}
        onClosed={handleSheetClosed}
        onSend={handleSend}
        onCopy={() => sheetEntry && handleCopy(sheetEntry)}
        onEdit={handleEdit}
        onDelete={handleDelete}
      />

      <AddContactModal
        visible={showModal}
        onClose={handleCloseModal}
        onSave={handleSave}
        editing={editingEntry}
        isSaving={isAdding || isUpdating}
        saveError={addError as Error | null}
      />
    </View>
  );
}
