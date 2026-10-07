/**
 * Contacts Modal Component (#980)
 *
 * Allows users to import contacts, match them with known Stellar addresses,
 * and invite collaborators to royalty splits via native share sheet deep links.
 */

import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  ScrollView,
  TextInput,
  ActivityIndicator,
} from "react-native";
import { TouchButton } from "./TouchButton";
import {
  contactsService,
  PhoneContact,
  ContactsError,
} from "../services/contacts";
import { colors, spacing } from "../theme";

interface ContactsModalProps {
  visible: boolean;
  onClose: () => void;
  onSelectContact?: (contact: PhoneContact) => void;
}

export const ContactsModal: React.FC<ContactsModalProps> = ({
  visible,
  onClose,
  onSelectContact,
}) => {
  const [contacts, setContacts] = useState<PhoneContact[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invitedIds, setInvitedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (visible) {
      loadContacts();
    }
  }, [visible]);

  const loadContacts = async () => {
    try {
      setIsLoading(true);
      setError(null);
      const imported = await contactsService.importContacts();
      const matched = await contactsService.matchContactsWithStellar(imported);
      setContacts(matched);
    } catch (err: unknown) {
      if (err instanceof ContactsError) {
        setError(err.message);
      } else {
        setError("Failed to import address book contacts.");
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleInvite = async (contact: PhoneContact) => {
    const result = await contactsService.inviteContact(contact);
    if (result.completed) {
      setInvitedIds((prev) => new Set(prev).add(contact.id));
    }
  };

  const filteredContacts = contacts.filter((c) => {
    const q = searchQuery.toLowerCase();
    const nameMatch = c.name.toLowerCase().includes(q);
    const phoneMatch = c.phoneNumbers.some((p) => p.number.includes(q));
    const emailMatch = c.emailAddresses.some((e) => e.email.toLowerCase().includes(q));
    return nameMatch || phoneMatch || emailMatch;
  });

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalContainer}>
          {/* Header */}
          <View style={styles.header}>
            <View>
              <Text style={styles.title}>Collaborator Contacts</Text>
              <Text style={styles.subtitle}>Import & invite creators from your address book</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <Text style={styles.closeText}>✕</Text>
            </TouchableOpacity>
          </View>

          {/* Search Bar */}
          <TextInput
            style={styles.searchInput}
            placeholder="Search by name, phone, or email..."
            placeholderTextColor={colors.textMuted}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />

          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
              <TouchButton
                title="Retry / Check Permission"
                variant="secondary"
                onPress={loadContacts}
                style={{ marginTop: spacing.sm }}
              />
            </View>
          ) : isLoading ? (
            <View style={styles.loadingBox}>
              <ActivityIndicator size="large" color={colors.primary} />
              <Text style={styles.loadingText}>Importing and matching contacts...</Text>
            </View>
          ) : (
            <ScrollView style={styles.scrollArea}>
              {filteredContacts.length === 0 ? (
                <View style={styles.emptyBox}>
                  <Text style={styles.emptyText}>No contacts found.</Text>
                </View>
              ) : (
                filteredContacts.map((contact) => {
                  const isInvited = invitedIds.has(contact.id);
                  return (
                    <View key={contact.id} style={styles.contactRow}>
                      <View style={styles.avatarCircle}>
                        <Text style={styles.avatarText}>{contact.name.charAt(0)}</Text>
                      </View>

                      <View style={styles.contactInfo}>
                        <View style={styles.nameRow}>
                          <Text style={styles.contactName}>{contact.name}</Text>
                          {contact.hasMatchedStellar && (
                            <View style={styles.matchedBadge}>
                              <Text style={styles.matchedBadgeText}>On Stellar</Text>
                            </View>
                          )}
                        </View>

                        {contact.matchedContractName && (
                          <Text style={styles.contractMatchText}>
                            Co-creator on {contact.matchedContractName}
                          </Text>
                        )}

                        <Text style={styles.contactDetail}>
                          {contact.phoneNumbers[0]?.number || contact.emailAddresses[0]?.email}
                        </Text>
                      </View>

                      <View style={styles.actionCol}>
                        {contact.hasMatchedStellar ? (
                          <TouchButton
                            title="Add to Split"
                            variant="primary"
                            onPress={() => onSelectContact?.(contact)}
                            style={styles.actionBtn}
                            textStyle={{ fontSize: 11 }}
                          />
                        ) : (
                          <TouchButton
                            title={isInvited ? "✓ Invited" : "Invite"}
                            variant={isInvited ? "secondary" : "outline"}
                            onPress={() => handleInvite(contact)}
                            style={styles.actionBtn}
                            textStyle={{ fontSize: 11 }}
                          />
                        )}
                      </View>
                    </View>
                  );
                })
              )}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.75)",
    justifyContent: "flex-end",
  },
  modalContainer: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: spacing.md,
    height: "85%",
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.sm,
  },
  title: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.text,
  },
  subtitle: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 2,
  },
  closeButton: {
    padding: spacing.xs,
  },
  closeText: {
    fontSize: 18,
    color: colors.textMuted,
  },
  searchInput: {
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: 12,
    padding: spacing.sm,
    color: colors.text,
    fontSize: 13,
    marginBottom: spacing.md,
  },
  scrollArea: {
    flex: 1,
  },
  contactRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.background,
    borderRadius: 12,
    padding: spacing.sm,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  avatarCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.primaryLight,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.primary,
  },
  contactInfo: {
    flex: 1,
    marginLeft: spacing.sm,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  contactName: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
  },
  matchedBadge: {
    backgroundColor: colors.successLight,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  matchedBadgeText: {
    fontSize: 10,
    fontWeight: "700",
    color: colors.success,
  },
  contractMatchText: {
    fontSize: 11,
    color: colors.primary,
    marginTop: 1,
  },
  contactDetail: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 1,
  },
  actionCol: {
    marginLeft: spacing.xs,
  },
  actionBtn: {
    minHeight: 32,
    paddingVertical: 4,
    paddingHorizontal: 10,
    marginVertical: 0,
  },
  errorBox: {
    backgroundColor: colors.dangerLight,
    borderColor: colors.danger,
    borderWidth: 1,
    borderRadius: 12,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
  },
  loadingBox: {
    padding: spacing.xl,
    alignItems: "center",
  },
  loadingText: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: spacing.sm,
  },
  emptyBox: {
    padding: spacing.xl,
    alignItems: "center",
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: 13,
  },
});
