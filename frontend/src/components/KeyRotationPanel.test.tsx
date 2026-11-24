import { StrKey } from "@stellar/stellar-sdk";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { KeyRotationPanel } from "./KeyRotationPanel";

test("requires a valid Stellar secret seed only for direct key rotation", () => {
  render(<KeyRotationPanel adminToken="" />);
  const button = screen.getByRole("button", { name: "Rotate Key" });
  const input = screen.getByLabelText("New Stellar secret key");

  for (const value of ["S", "Shello", "S" + "A".repeat(55)]) {
    fireEvent.change(input, { target: { value } });
    expect(button).toBeDisabled();
  }

  const seed = StrKey.encodeEd25519SecretSeed(Buffer.alloc(32));
  fireEvent.change(input, { target: { value: `  ${seed}  ` } });
  expect(button).toBeEnabled();

  fireEvent.change(input, { target: { value: "S" } });
  fireEvent.click(screen.getByRole("button", { name: "Reload from File" }));
  expect(button).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Reload from Provider" }));
  expect(button).toBeEnabled();
});
