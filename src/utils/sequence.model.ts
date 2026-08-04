import { Schema, model, type Document } from 'mongoose';

interface ICounter extends Document<string> {
  seq: number;
}

const counterSchema = new Schema<ICounter>({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

const Counter = model<ICounter>('Counter', counterSchema);

/** Atomically increments and returns the next number in a named sequence (e.g. "quotation", "bill"). */
export async function nextSequence(name: string): Promise<number> {
  const counter = await Counter.findByIdAndUpdate(
    name,
    { $inc: { seq: 1 } },
    { new: true, upsert: true },
  );
  return counter.seq;
}

/**
 * One-time migration guard for a sequence that's replacing an older count-based scheme:
 * if this counter has never been used before, fast-forwards it past whatever the highest
 * existing code already is, so the very next `nextSequence()` call can't collide with
 * pre-existing records. `$max` makes the fast-forward itself safe even if two requests
 * both run this seed step concurrently for the same brand-new counter. A no-op once the
 * counter exists (the normal, permanent case after the first call).
 */
export async function seedSequenceFromExisting(name: string, fetchMaxExisting: () => Promise<number>): Promise<void> {
  const alreadySeeded = await Counter.exists({ _id: name });
  if (alreadySeeded) return;

  const maxExisting = await fetchMaxExisting();
  if (maxExisting > 0) {
    await Counter.findOneAndUpdate({ _id: name }, { $max: { seq: maxExisting } }, { upsert: true });
  }
}
