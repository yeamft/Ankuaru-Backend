export type ParsedTelegramListing = {
  intent: "buy" | "sell";
  quantity: string | null;
  description: string;
  region: string | null;
  grade: string | null;
  process: string | null;
  transaction_type: string | null;
};

const BUY_TERMS = ["i want to: buy", "looking for", "requirement", "i need", "need to buy", "ግዢ"];
const SELL_TERMS = ["i want to: sell", "for sale", "i have", "available", "ሽያጭ"];

const REGIONS: [string, string][] = [
  ["yirgacheffe", "Yirgacheffe"],
  ["sidama", "Sidama"],
  ["sidamo", "Sidama"],
  ["guji", "Guji"],
  ["kaffa", "Kaffa"],
  ["keffa", "Kaffa"],
  ["lekempti", "Lekempti"],
  ["nekemte", "Lekempti"],
  ["jimma", "Jimma"],
  ["djimma", "Jimma"],
  ["bale", "Bale"],
  ["benchmaji", "Bench Maji"],
  ["banch maji", "Bench Maji"],
  ["ilu aba bora", "Ilu Aba Bora"],
];

/**
 * Normalizes the recurring structured trade format used in the Telegram group.
 * It is intentionally conservative: messages that do not identify a coffee trade
 * request are returned for manual handling instead of becoming market listings.
 */
export function parseTelegramListing(raw: string): ParsedTelegramListing | null {
  const text = raw.trim();
  const lower = text.toLowerCase();
  if (!(lower.includes("coffee") || text.includes("ቡ"))) return null;

  const mentions = (term: string) => lower.includes(term) || text.includes(term);
  const intent = BUY_TERMS.some(mentions) ? "buy" : SELL_TERMS.some(mentions) ? "sell" : null;
  if (!intent) return null;

  const region = REGIONS.find(([needle]) => lower.includes(needle))?.[1] ?? null;

  const grades = [1, 2, 3, 4, 5]
    .filter((grade) =>
      [`g${grade}`, `g-${grade}`, `g ${grade}`, `grade ${grade}`].some((form) =>
        lower.includes(form),
      ),
    )
    .map((grade) => `G${grade}`);
  const labelledGrade = extractField(text, "grade");
  const grade =
    (labelledGrade && normalizeGrade(labelledGrade)) || (grades.length ? grades.join(" & ") : null);

  const process =
    lower.includes("unwashed") || lower.includes("unwash")
      ? "Unwashed"
      : lower.includes("washed")
        ? "Washed"
        : lower.includes("natural")
          ? "Natural"
          : null;
  const transaction_type = lower.includes("horizontal")
    ? "Horizontal"
    : lower.includes("vertical")
      ? "Vertical"
      : null;

  const quantity =
    extractField(text, "quantity") ?? extractField(text, "volume") ?? extractField(text, "ብዛት");

  return {
    intent,
    quantity,
    description: stripPhoneNumbers(text),
    region,
    grade,
    process,
    transaction_type,
  };
}

function extractField(text: string, name: string): string | null {
  for (const line of text.split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    if (line.slice(0, separator).trim().toLowerCase() === name) {
      const value = line.slice(separator + 1).trim();
      if (value) return value;
    }
  }
  return null;
}

/** Runs of seven or more digits are treated as phone numbers. */
export function stripPhoneNumbers(value: string): string {
  const stripped = value.replace(/[0-9]+/g, (digits) =>
    digits.length >= 7 ? "[contact removed]" : digits,
  );
  return Array.from(stripped.trim()).slice(0, 2000).join("");
}

function normalizeGrade(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  if (!normalized) return null;
  const compact = normalized.replace(/[ -]/g, "");
  if (/^[0-9]*$/.test(compact)) return `G${compact}`;
  return compact.startsWith("G") ? compact : normalized;
}
