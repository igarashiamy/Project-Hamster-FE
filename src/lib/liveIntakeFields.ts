// src/lib/liveIntakeFields.ts
//
// The "rules" for live dictation: which form boxes the AI may fill, and how a
// spoken finding gets merged into what is already in the box.
// This file has no browser or network code, so it is easy to test.

import type { BasicExaminationForm } from "@/services/MedicalRecordService";

/** The boxes on the vet's Basic Examination form that the AI may fill. */
export const LIVE_INTAKE_FIELDS = [
  "weight",
  "temperature",
  "heartRate",
  "symptoms",
  "physicalExaminationNotes",
  "diagnosis",
  "treatment",
] as const satisfies ReadonlyArray<keyof BasicExaminationForm>;

export type LiveIntakeField = (typeof LIVE_INTAKE_FIELDS)[number];

export const LIVE_INTAKE_FIELD_LABELS: Record<LiveIntakeField, string> = {
  weight: "Weight (g)",
  temperature: "Temperature (°C)",
  heartRate: "Heart rate (bpm)",
  symptoms: "Confirmed symptoms",
  physicalExaminationNotes: "Physical examination notes",
  diagnosis: "Confirmed diagnosis",
  treatment: "Suggested treatment",
};

export type LiveIntakeUpdate = {
  field: LiveIntakeField;
  value: string;
  /** "replace" overwrites the box; "append" adds to it. */
  mode: "append" | "replace";
};

const NUMERIC_FIELDS: ReadonlySet<LiveIntakeField> = new Set([
  "weight",
  "temperature",
  "heartRate",
]);

export function isLiveIntakeField(value: unknown): value is LiveIntakeField {
  return (
    typeof value === "string" &&
    (LIVE_INTAKE_FIELDS as readonly string[]).includes(value)
  );
}

/**
 * Turns whatever Gemini sent as function-call arguments into a clean update,
 * or null if it is not usable. Never trust the model's output blindly.
 */
export function parseLiveIntakeUpdate(
  args: Record<string, unknown> | undefined,
): LiveIntakeUpdate | null {
  if (!args || !isLiveIntakeField(args.field)) return null;

  const rawValue = args.value;
  const value =
    typeof rawValue === "string"
      ? rawValue.trim()
      : typeof rawValue === "number" && Number.isFinite(rawValue)
        ? String(rawValue)
        : "";
  if (!value) return null;

  return {
    field: args.field,
    value,
    mode: args.mode === "replace" ? "replace" : "append",
  };
}

/** Pulls the first number out of text like "128 grams" -> "128". */
function extractNumber(value: string): string | null {
  const match = value.replace(",", ".").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? String(parsed) : null;
}

/**
 * Returns a new copy of the form with one spoken finding merged in.
 * - Number boxes are always overwritten (a new weight replaces the old one).
 * - Symptoms are kept as a comma-separated list with no duplicates.
 * - Note boxes get the new text on a new line, unless it is already there.
 */
export function applyLiveIntakeUpdate(
  form: BasicExaminationForm,
  update: LiveIntakeUpdate,
): BasicExaminationForm {
  const { field, mode } = update;
  const value = update.value.trim();
  if (!value) return form;

  if (NUMERIC_FIELDS.has(field)) {
    const numeric = extractNumber(value);
    if (numeric === null || numeric === form[field]) return form;
    return { ...form, [field]: numeric };
  }

  if (field === "symptoms") {
    const existing =
      mode === "replace"
        ? []
        : form.symptoms
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);
    const seen = new Set(existing.map((item) => item.toLowerCase()));
    for (const item of value.split(",").map((part) => part.trim())) {
      if (item && !seen.has(item.toLowerCase())) {
        existing.push(item);
        seen.add(item.toLowerCase());
      }
    }
    const next = existing.join(", ");
    return next === form.symptoms ? form : { ...form, symptoms: next };
  }

  const current = form[field].trim();
  if (mode === "replace" || !current) {
    return current === value ? form : { ...form, [field]: value };
  }
  if (current.toLowerCase().includes(value.toLowerCase())) return form;
  return { ...form, [field]: `${current}\n${value}` };
}
