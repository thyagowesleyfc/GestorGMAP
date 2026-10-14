import {
  AllocateTomboSequence,
  formatTomboSequence,
  normalizeAllocateTomboSequenceCommand,
  type TomboSequenceAllocator
} from "../../../src/modules/patrimony/application/allocate-tombo-sequence";
import { describe, expect, it } from "vitest";

describe("allocate tombo sequence", () => {
  it("normalizes patrimonial group before allocation", async () => {
    const allocator: TomboSequenceAllocator = {
      async allocate(input) {
        return {
          organCode: "011",
          ...input,
          sequenceNumber: 1,
          tombo: formatTomboSequence({ ...input, sequenceNumber: 1 })
        };
      }
    };

    const result = await new AllocateTomboSequence(allocator).execute({
      patrimonialGroupCode: " 01 "
    });

    expect(result).toEqual({
      organCode: "011",
      patrimonialGroupCode: "01",
      sequenceNumber: 1,
      tombo: "011-01-000001"
    });
  });

  it("formats sequence numbers as normalized tombos", () => {
    expect(
      formatTomboSequence({
        patrimonialGroupCode: "02",
        sequenceNumber: 42
      })
    ).toBe("011-02-000042");
  });

  it("rejects invalid patrimonial groups", () => {
    expect(() => normalizeAllocateTomboSequenceCommand({ patrimonialGroupCode: " " })).toThrow(
      "Patrimonial group code must not be blank."
    );
    expect(() => normalizeAllocateTomboSequenceCommand({ patrimonialGroupCode: "1" })).toThrow(
      /exactly two digits/
    );
    expect(() => normalizeAllocateTomboSequenceCommand({ patrimonialGroupCode: "AB" })).toThrow(
      /exactly two digits/
    );
  });

  it("rejects invalid sequence numbers", () => {
    expect(() =>
      formatTomboSequence({
        patrimonialGroupCode: "01",
        sequenceNumber: 0
      })
    ).toThrow(/positive integer/);
  });
});
