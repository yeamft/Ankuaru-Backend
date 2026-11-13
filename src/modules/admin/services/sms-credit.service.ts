/** Below this many messages the dashboard warns that phone verification may stop. */
export const LOW_SMS_CREDIT = 500;
const CACHE_MS = 5 * 60_000;

export type SmsCredit =
  | { configured: false }
  | {
      configured: true;
      provider: "GeezSMS";
      /** Null when Geez could not be reached; the dashboard then says so. */
      messages_left: number | null;
      balance: string | null;
      low: boolean;
      checked_at: string;
    };

let cached: { at: number; value: SmsCredit } | null = null;

/**
 * The SMS credit left for phone verification codes, from GeezSMS. Cached for a
 * few minutes so the dashboard never calls Geez on every visit; the token is
 * only ever sent to Geez.
 */
export async function smsCredit(token = process.env.GEEZ_TOKEN): Promise<SmsCredit> {
  if (!token) return { configured: false };
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  let value: SmsCredit;
  try {
    const url = new URL("https://api.geezsms.com/api/v1/balance");
    url.searchParams.set("token", token);
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(8_000),
    });
    const body = (await response.json().catch(() => null)) as
      | { error?: unknown; data?: { total_sms?: unknown; total_amount?: unknown } }
      | null;
    const left = Number(body?.data?.total_sms);
    if (!response.ok || body?.error !== false || !Number.isFinite(left)) throw new Error("no balance");
    value = {
      configured: true,
      provider: "GeezSMS",
      messages_left: left,
      balance: typeof body?.data?.total_amount === "string" ? body.data.total_amount : null,
      low: left < LOW_SMS_CREDIT,
      checked_at: new Date().toISOString(),
    };
  } catch {
    value = {
      configured: true,
      provider: "GeezSMS",
      messages_left: null,
      balance: null,
      low: false,
      checked_at: new Date().toISOString(),
    };
  }
  cached = { at: Date.now(), value };
  return value;
}
