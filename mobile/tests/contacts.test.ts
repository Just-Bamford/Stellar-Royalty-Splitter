import { describe, it, expect, beforeEach } from "vitest";
import { contactsService, ContactsError } from "../src/services/contacts";

describe("Contacts Import & Stellar Matching (#980)", () => {
  beforeEach(async () => {
    // Reset test state to clean opt-in default (OFF)
    await contactsService.setContactsOptIn(false);
    contactsService._setMockContacts(null);
    contactsService._setMockPermission(false);
  });

  describe("Privacy Opt-In Control", () => {
    it("defaults contacts access to OFF (false)", async () => {
      const optedIn = await contactsService.getContactsOptIn();
      expect(optedIn).toBe(false);
    });

    it("allows user to explicitly opt-in and opt-out", async () => {
      await contactsService.setContactsOptIn(true);
      expect(await contactsService.getContactsOptIn()).toBe(true);

      await contactsService.setContactsOptIn(false);
      expect(await contactsService.getContactsOptIn()).toBe(false);
    });

    it("aborts and throws OPTED_OUT error if contacts are imported while opted out", async () => {
      await contactsService.setContactsOptIn(false);
      contactsService._setMockPermission(true);

      await expect(contactsService.importContacts()).rejects.toThrowError(
        /Contacts access is disabled/
      );
    });
  });

  describe("Primary Flow: Permission Granted & Contact Matching", () => {
    it("imports contacts when permission is granted and opted in", async () => {
      await contactsService.setContactsOptIn(true);
      contactsService._setMockPermission(true);

      const contacts = await contactsService.importContacts();
      expect(contacts.length).toBeGreaterThan(0);
      expect(contacts[0].name).toBeDefined();
    });

    it("matches known contacts with Stellar addresses and contract names", async () => {
      await contactsService.setContactsOptIn(true);
      contactsService._setMockPermission(true);

      const contacts = await contactsService.importContacts();
      const matched = await contactsService.matchContactsWithStellar(contacts);

      const devon = matched.find((c) => c.name === "Devon Vance");
      expect(devon).toBeDefined();
      expect(devon?.hasMatchedStellar).toBe(true);
      expect(devon?.stellarAddress).toBe("GBKT7X2...1022");
      expect(devon?.matchedContractName).toBe("Game Soundtrack Split");
    });

    it("generates invite share payload with deep link for unmatched contact", async () => {
      const contact = {
        id: "cnt-unmatched",
        name: "Taylor Swift",
        phoneNumbers: [{ label: "mobile", number: "+1 (555) 000-1111" }],
        emailAddresses: [{ label: "work", email: "taylor@music.com" }],
      };

      const res = await contactsService.inviteContact(contact, "ref-test-123");
      expect(res).toBeDefined();
    });
  });

  describe("Boundary Cases", () => {
    it("handles empty address book gracefully", async () => {
      await contactsService.setContactsOptIn(true);
      contactsService._setMockPermission(true);
      contactsService._setMockContacts([]);

      const contacts = await contactsService.importContacts();
      expect(contacts).toEqual([]);

      const matched = await contactsService.matchContactsWithStellar(contacts);
      expect(matched).toEqual([]);
    });

    it("handles contacts with no matched Stellar accounts", async () => {
      const unmatchedContacts = [
        {
          id: "cnt-99",
          name: "Unregistered User",
          phoneNumbers: [{ label: "mobile", number: "+1 (555) 999-9999" }],
          emailAddresses: [{ label: "work", email: "unknown@example.com" }],
        },
      ];

      const matched = await contactsService.matchContactsWithStellar(unmatchedContacts);
      expect(matched.length).toBe(1);
      expect(matched[0].hasMatchedStellar).toBe(false);
      expect(matched[0].stellarAddress).toBeUndefined();
    });
  });

  describe("Failure Cases", () => {
    it("throws PERMISSION_DENIED when contacts permission is rejected", async () => {
      await contactsService.setContactsOptIn(true);
      contactsService._setMockPermission(false);

      await expect(contactsService.importContacts()).rejects.toThrowError(
        /Contacts permission was denied/
      );
    });
  });
});
