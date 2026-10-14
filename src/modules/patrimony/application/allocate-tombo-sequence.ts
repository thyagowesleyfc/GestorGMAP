import { normalizeTombo } from "../domain/tombo";

export const GMAP_TOMBO_ORGAN_CODE = "011";

export type AllocateTomboSequenceCommand = {
  patrimonialGroupCode: string;
};

export type AllocateTomboSequenceResult = {
  organCode: typeof GMAP_TOMBO_ORGAN_CODE;
  patrimonialGroupCode: string;
  sequenceNumber: number;
  tombo: string;
};

export interface TomboSequenceAllocator {
  allocate(input: AllocateTomboSequenceCommand): Promise<AllocateTomboSequenceResult>;
}

export class AllocateTomboSequence {
  constructor(private readonly allocator: TomboSequenceAllocator) {}

  async execute(input: AllocateTomboSequenceCommand): Promise<AllocateTomboSequenceResult> {
    const command = normalizeAllocateTomboSequenceCommand(input);

    return this.allocator.allocate(command);
  }
}

export function normalizeAllocateTomboSequenceCommand(
  input: AllocateTomboSequenceCommand
): AllocateTomboSequenceCommand {
  const patrimonialGroupCode = input.patrimonialGroupCode.trim().toUpperCase();

  if (patrimonialGroupCode.length === 0) {
    throw new Error("Patrimonial group code must not be blank.");
  }

  if (!/^[0-9]{2}$/.test(patrimonialGroupCode)) {
    throw new Error("Patrimonial group code must contain exactly two digits.");
  }

  return { patrimonialGroupCode };
}

export function formatTomboSequence(input: {
  patrimonialGroupCode: string;
  sequenceNumber: number;
}): string {
  if (!Number.isInteger(input.sequenceNumber) || input.sequenceNumber <= 0) {
    throw new Error("Tombo sequence number must be a positive integer.");
  }

  const sequence = input.sequenceNumber.toString().padStart(6, "0");

  return normalizeTombo(`${GMAP_TOMBO_ORGAN_CODE}-${input.patrimonialGroupCode}-${sequence}`);
}
