import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../../../infrastructure/database/db.js";
import { transaction } from "../../../infrastructure/database/index.js";
import { traders, verificationRequests } from "../../../infrastructure/database/schema.js";
import { ApiError } from "../../../shared/errors.js";
import { audit } from "../../../infrastructure/database/index.js";
import { kycApplicationSchema } from "../schemas.js";

const applicationProjection = {
  id: verificationRequests.id,
  verification_type: verificationRequests.verificationType,
  details: verificationRequests.details,
  document_summary: verificationRequests.documentSummary,
  status: verificationRequests.status,
  created_at: verificationRequests.createdAt,
};

export async function currentApplication(database: Database, traderId: string) {
  const [application] = await database.select(applicationProjection)
    .from(verificationRequests)
    .where(eq(verificationRequests.traderId, traderId))
    .orderBy(desc(verificationRequests.createdAt), desc(verificationRequests.id))
    .limit(1);
  return application ?? null;
}

export async function submitApplication(database: Database, traderId: string, input: unknown) {
  const parsed = kycApplicationSchema.safeParse(input);
  if (!parsed.success) {
    throw new ApiError(400, "invalid_kyc_application", parsed.error.issues[0]?.message ?? "Review the verification details.");
  }

  return transaction(database, async (tx) => {
    const [trader] = await tx.select({
      verified: traders.verified,
      phoneVerified: traders.phoneVerified,
      verificationTier: traders.verificationTier,
      displayName: traders.displayName,
    }).from(traders).where(eq(traders.id, traderId)).for("update");
    if (!trader) throw new ApiError(401, "unauthorized", "A valid session is required.");
    if (!trader.phoneVerified) {
      throw new ApiError(403, "phone_verification_required", "Verify your phone number before applying for trader verification.");
    }

    if (parsed.data.verification_type === "individual" && trader.verified) {
      throw new ApiError(409, "individual_already_verified", "Your individual identity is already verified.");
    }
    if (parsed.data.verification_type === "business" && (!trader.verified || trader.verificationTier !== "individual")) {
      throw new ApiError(403, "individual_verification_required", "Verify your individual identity before applying as a business.");
    }

    const [pending] = await tx.select({ id: verificationRequests.id })
      .from(verificationRequests)
      .where(and(eq(verificationRequests.traderId, traderId), eq(verificationRequests.status, "Pending")))
      .limit(1);
    if (pending) throw new ApiError(409, "kyc_application_pending", "A verification request is already waiting for review.");

    const details = parsed.data;
    const summary = details.verification_type === "individual"
      ? `Individual identity review · ${details.identity_method} · ${trader.displayName}`
      : `Business verification · ${details.business_name}`;
    const [application] = await tx.insert(verificationRequests).values({
      traderId,
      verificationType: details.verification_type,
      details,
      documentSummary: summary,
    }).returning(applicationProjection);
    await audit(tx, traderId, "kyc.submitted", "verification", application.id);
    return application;
  });
}
