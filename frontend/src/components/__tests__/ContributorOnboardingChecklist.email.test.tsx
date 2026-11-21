import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ContributorOnboardingChecklist } from "../ContributorOnboardingChecklist";
import { api } from "../../api";

vi.mock("../../api");

const mockApi = api as any;
const WALLET = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";

function submitEmail(value: string) {
  const input = screen.getByLabelText("Email address");
  fireEvent.change(input, { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: /Send Reminder Email/i }));
}

describe("ContributorOnboardingChecklist email validation (#1394)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getOnboardingStatus = vi.fn().mockResolvedValue({
      walletAddress: WALLET,
      completionPercentage: 0,
      items: [],
      email: "",
    });
    mockApi.sendOnboardingReminder = vi.fn().mockResolvedValue({
      message: "Reminder sent",
      emailDetails: { previewText: "preview" },
    });
  });

  test.each(["plainaddress", "a@b", "user@", "user @example.com"])(
    "shows an inline error and does not call the API for %s",
    async (value) => {
      render(<ContributorOnboardingChecklist walletAddress={WALLET} />);
      await screen.findByLabelText("Email address");

      submitEmail(value);

      expect(await screen.findByRole("alert")).toHaveTextContent("Please enter a valid email address.");
      expect(screen.getByLabelText("Email address")).toHaveAttribute("aria-invalid", "true");
      expect(mockApi.sendOnboardingReminder).not.toHaveBeenCalled();
    },
  );

  test("sends a valid email, trimmed, to the API", async () => {
    render(<ContributorOnboardingChecklist walletAddress={WALLET} />);
    await screen.findByLabelText("Email address");

    submitEmail("  contributor@example.com ");

    await waitFor(() =>
      expect(mockApi.sendOnboardingReminder).toHaveBeenCalledWith(WALLET, "contributor@example.com"),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Reminder sent");
  });
});
