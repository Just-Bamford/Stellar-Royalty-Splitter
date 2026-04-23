import { z } from "zod";

export const stellarAddress = z
  .string()
  .regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar address");

export const contractAddress = z
  .string()
  .regex(/^C[A-Z2-7]{55}$/, "Invalid contract address");

export const basisPoints = z.number().int().min(0).max(10000);

export const initializeSchema = z
  .object({
    contractId: contractAddress,
    walletAddress: stellarAddress,
    collaborators: z.array(stellarAddress).min(1).max(20),
    shares: z.array(basisPoints).min(1).max(20),
  })
  .refine((d) => d.collaborators.length === d.shares.length, {
    message: "collaborators and shares must be the same length",
  })
  .refine((d) => d.shares.reduce((a, b) => a + b, 0) === 10000, {
    message: "shares must sum to 10000 basis points",
  });

export const distributeSchema = z.object({
  contractId: contractAddress,
  walletAddress: stellarAddress,
  tokenId: contractAddress,
  amount: z.number().int().positive(),
});

export const setRoyaltyRateSchema = z.object({
  contractId: contractAddress,
  walletAddress: stellarAddress,
  royaltyRate: basisPoints,
});

export const recordSecondarySaleSchema = z.object({
  contractId: contractAddress,
  walletAddress: stellarAddress,
  nftId: z.string().min(1),
  previousOwner: stellarAddress,
  newOwner: stellarAddress,
  salePrice: z.number().int().positive(),
  saleToken: contractAddress,
  royaltyRate: basisPoints,
});

export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: result.error.errors.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        })),
      });
    }
    req.body = result.data;
    next();
  };
}
