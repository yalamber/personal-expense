import { describe, expect, it } from "vitest";
import { parseFrom } from "../src/worker/lib/mailer";

describe("parseFrom", () => {
  it("splits a display name and address", () => {
    expect(parseFrom("Family Money <money@leadbase.stream>")).toEqual({ email: "money@leadbase.stream", name: "Family Money" });
    expect(parseFrom('"Family, Money" <money@leadbase.stream>')).toEqual({ email: "money@leadbase.stream", name: "Family, Money" });
  });

  it("accepts a bare address", () => {
    expect(parseFrom("money@leadbase.stream")).toEqual({ email: "money@leadbase.stream" });
    expect(parseFrom("<money@leadbase.stream>")).toEqual({ email: "money@leadbase.stream" });
  });
});
