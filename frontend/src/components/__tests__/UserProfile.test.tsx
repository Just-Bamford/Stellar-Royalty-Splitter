import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { UserProfile } from "../UserProfile";
import { useSocialStore } from "../../store/socialStore";

describe("UserProfile", () => {
  const WALLET_ADDR = "GALAXY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZAAAA";
  const OTHER_ADDR = "GSTELLAR9876543210ABCDEFGHIJKLMNOPQRSTUVWXYZBBBB";

  beforeEach(() => {
    useSocialStore.setState({
      following: [],
    });
  });

  it("renders user profile info, stats, and badges correctly", () => {
    render(<UserProfile walletAddress={WALLET_ADDR} targetAddress={WALLET_ADDR} />);

    expect(screen.getByText("Aria Vance")).toBeInTheDocument();
    expect(screen.getByText("Music Producer")).toBeInTheDocument();
    expect(screen.getByText(/Total Earned/i)).toBeInTheDocument();
    expect(screen.getByText(/Active Streak/i)).toBeInTheDocument();
    expect(screen.getByText(/Achievements & Badges/i)).toBeInTheDocument();
  });

  it("opens edit modal and updates profile for own account", () => {
    render(<UserProfile walletAddress={WALLET_ADDR} targetAddress={WALLET_ADDR} />);

    const editBtn = screen.getByRole("button", { name: /Edit Profile/i });
    fireEvent.click(editBtn);

    expect(screen.getByRole("heading", { name: "Edit Profile" })).toBeInTheDocument();

    const usernameInput = screen.getByLabelText("Display Name");
    fireEvent.change(usernameInput, { target: { value: "Aria Vance Updated" } });

    const saveBtn = screen.getByRole("button", { name: /Save Changes/i });
    fireEvent.click(saveBtn);

    expect(screen.getByText("Aria Vance Updated")).toBeInTheDocument();
  });

  it("allows following and unfollowing another creator", () => {
    render(<UserProfile walletAddress={WALLET_ADDR} targetAddress={OTHER_ADDR} />);

    const followBtn = screen.getByRole("button", { name: /Follow User/i });
    fireEvent.click(followBtn);

    expect(useSocialStore.getState().isFollowing(OTHER_ADDR)).toBe(true);

    const followingBtn = screen.getByRole("button", { name: /Unfollow User/i });
    fireEvent.click(followingBtn);

    expect(useSocialStore.getState().isFollowing(OTHER_ADDR)).toBe(false);
  });
});
